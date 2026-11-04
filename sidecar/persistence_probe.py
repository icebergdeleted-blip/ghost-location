# SPDX-License-Identifier: GPL-3.0-or-later
"""Hardware persistence probe helper (manual use only; not shipped in the app).

Answers one question for docs/persistence-findings.md: which iOS location
simulation paths keep their state after the host client goes away?

Every command needs an explicit --udid. Nothing defaults to the first device.
Output is one JSON object per line on the real stdout. Upstream logging goes to stderr.

Commands:
  facts         --udid U            iOS version, Developer Mode, DDI mount state,
                                    RSD location-related services, legacy service reachability.
  legacy-set    --udid U --lat --lon [--via usbmux|rsd] [--service NAME]
  legacy-clear  --udid U            [--via usbmux|rsd] [--service NAME]
  unmount-ddi   --udid U            unmount the Personalized developer image (test step 5c).

The DVT path is NOT driven from here. scripts/persistence-probe.mjs drives it
through Ghost's real IosAdapter -> ios_bridge.py, so it uses exactly Ghost's code.
"""
import argparse
import asyncio
from datetime import datetime, timezone
import importlib.metadata
import json
import sys

# Importing the bridge installs Ghost's strict transport override and redirects
# sys.stdout to stderr. Its PROTOCOL_OUT is the real stdout.
import ios_bridge as bridge

from pymobiledevice3.remote import userspace_tunnel
from pymobiledevice3.services.mobile_image_mounter import PersonalizedImageMounter
from pymobiledevice3.services.simulate_location import DtSimulateLocation

LEGACY_SERVICE = DtSimulateLocation.SERVICE_NAME  # "com.apple.dt.simulatelocation"


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def out(value):
    bridge.PROTOCOL_OUT.write(json.dumps({"ts": now(), **value}, ensure_ascii=True) + "\n")
    bridge.PROTOCOL_OUT.flush()


def legacy_client(provider, service_name):
    """Upstream DtSimulateLocation, optionally with a different advertised service name."""
    if service_name == LEGACY_SERVICE:
        return DtSimulateLocation(provider)
    named = type("NamedDtSimulateLocation", (DtSimulateLocation,), {"SERVICE_NAME": service_name})
    return named(provider)


async def with_provider(udid, via, action):
    """Run action(provider) over a USB lockdown or a USB userspace RSD tunnel."""
    if via == "usbmux":
        async with await bridge.usb_lockdown(udid) as lockdown:
            if not lockdown.paired:
                raise RuntimeError("Unlock the iPhone and trust this computer first.")
            return await action(lockdown)
    tunnel = userspace_tunnel.UserspaceRsdTunnel(serial=udid, autopair=False, remotepairing_fallback=False)
    async with tunnel as rsd:
        if rsd.udid != udid:
            raise RuntimeError("Connected iPhone does not match the selected device.")
        return await action(rsd)


async def facts(udid):
    result = {"udid": udid, "pymobiledevice3": importlib.metadata.version("pymobiledevice3"),
              "pinned": bridge.PINNED_VERSION}
    async with await bridge.usb_lockdown(udid) as lockdown:
        result.update(paired=lockdown.paired, iosVersion=lockdown.product_version,
                      buildVersion=lockdown.all_values.get("BuildVersion"),
                      productType=lockdown.product_type)
        if lockdown.paired:
            result["developerMode"] = await lockdown.get_developer_mode_status()
            try:
                async with PersonalizedImageMounter(lockdown) as mounter:
                    result["personalizedImageMounted"] = await mounter.is_image_mounted("Personalized")
            except Exception as error:  # report, do not hide
                result["personalizedImageMounted"] = f"error: {bridge.explain(error)}"
            # Reachability only: open and close the service connection without sending a command.
            try:
                service = await lockdown.start_lockdown_developer_service(LEGACY_SERVICE)
                await service.close()
                result["legacyServiceOverUsbmux"] = "reachable"
            except Exception as error:
                result["legacyServiceOverUsbmux"] = f"unavailable: {bridge.explain(error)}"
    try:
        async def list_services(rsd):
            names = sorted(rsd.peer_info["Services"].keys())
            return [name for name in names if any(word in name.lower() for word in ("location", "simulat"))]
        result["rsdLocationServices"] = await with_provider(udid, "rsd", list_services)
    except Exception as error:
        result["rsdLocationServices"] = f"error: {bridge.explain(error)}"
    return result


async def legacy(udid, via, service_name, latitude=None, longitude=None):
    async def run(provider):
        client = legacy_client(provider, service_name)
        if latitude is None:
            await client.clear()
        else:
            await client.set(latitude, longitude)
    await with_provider(udid, via, run)
    # The legacy protocol has no reply. Success here means "bytes written", nothing more.
    return {"sent": True, "acknowledged": False, "via": via, "service": service_name}


async def unmount_ddi(udid):
    async with await bridge.usb_lockdown(udid) as lockdown:
        async with PersonalizedImageMounter(lockdown) as mounter:
            await mounter.umount()
    return {"unmounted": True}


def coordinate(value, limit):
    number = float(value)
    if not (-limit <= number <= limit):
        raise argparse.ArgumentTypeError(f"must be between -{limit} and {limit}")
    return number


def parser():
    root = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = root.add_subparsers(dest="command", required=True)
    for name in ("facts", "legacy-set", "legacy-clear", "unmount-ddi"):
        command = sub.add_parser(name)
        command.add_argument("--udid", required=True)
        if name.startswith("legacy"):
            command.add_argument("--via", choices=("usbmux", "rsd"), default="usbmux")
            command.add_argument("--service", default=LEGACY_SERVICE)
        if name == "legacy-set":
            command.add_argument("--lat", required=True, type=lambda v: coordinate(v, 90))
            command.add_argument("--lon", required=True, type=lambda v: coordinate(v, 180))
    return root


async def main(argv):
    args = parser().parse_args(argv)
    try:
        if args.command == "facts":
            result = await facts(args.udid)
        elif args.command == "legacy-set":
            result = await legacy(args.udid, args.via, args.service, args.lat, args.lon)
        elif args.command == "legacy-clear":
            result = await legacy(args.udid, args.via, args.service)
        else:
            result = await unmount_ddi(args.udid)
        out({"command": args.command, "ok": True, "result": result})
        return 0
    except Exception as error:
        out({"command": args.command, "ok": False, "error": bridge.explain(error)})
        return 1


if __name__ == "__main__":
    if importlib.metadata.version("pymobiledevice3") != bridge.PINNED_VERSION:
        out({"warning": f"pymobiledevice3 {importlib.metadata.version('pymobiledevice3')} is not the pinned "
                        f"{bridge.PINNED_VERSION}; record this in the findings."})
    sys.exit(asyncio.run(main(sys.argv[1:])))
