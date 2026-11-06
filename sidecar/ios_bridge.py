"""Ghost iOS bridge: private JSONL stdin/stdout, one explicitly selected USB or Wi-Fi DVT session.

No request is acknowledged until the awaited upstream operation completes.
The DVT set selector expects a device reply; clear is an upstream no-reply selector.
"""
import asyncio
from contextlib import AsyncExitStack, suppress
from contextvars import ContextVar
from datetime import datetime, timezone
import importlib.metadata
import json
import logging
import ipaddress
import math
import os
import re
import sys

PROTOCOL_VERSION = 1
PINNED_VERSION = "11.50.0"
REFRESH_INTERVAL = 1.0
LOCATION_ACK_TIMEOUT = 5.0
PROTOCOL_OUT = sys.stdout
# Third-party prints must never corrupt the protocol stream.
sys.stdout = sys.stderr
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

from packaging.version import Version
from pymobiledevice3 import usbmux
from pymobiledevice3.exceptions import AlreadyMountedError
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.remote import userspace_tunnel
from pymobiledevice3.exceptions import RemotePairingCompletedError
from pymobiledevice3.remote.tunnel_service import (CoreDeviceTunnelProxy, RemotePairingLockdownService,
                                                   RemotePairingTunnelService, get_remote_pairing_tunnel_services)
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation
from pymobiledevice3.services.mobile_image_mounter import PersonalizedImageMounter, fetch_personalized_ddi


def emit(value):
    PROTOCOL_OUT.write(json.dumps(value, ensure_ascii=True) + "\n")
    PROTOCOL_OUT.flush()


def explain(error):
    name = type(error).__name__
    if "Usbmuxd" in name:
        return "Apple USB services are unavailable. On Windows, install iTunes and reconnect the cable."
    if any(word in name for word in ("Pair", "Passcode", "UserDenied", "Password")):
        return "Unlock the iPhone and accept Trust This Computer, then try again."
    if "DeveloperMode" in name:
        return "Enable Developer Mode in iPhone Settings → Privacy & Security, restart, and confirm it."
    return f"{name}: {str(error) or 'The iPhone did not complete the operation.'}"


async def usb_lockdown(udid, autopair=False):
    if not isinstance(udid, str) or not re.fullmatch(r"[A-Za-z0-9-]{8,80}", udid):
        raise ValueError("A specific iPhone identifier is required.")
    # Explicit connection_type is essential: a paired phone may also appear over Wi-Fi.
    return await create_using_usbmux(serial=udid, connection_type="USB", autopair=autopair, pair_timeout=20)


# A request chooses its transport explicitly. Child tunnel tasks inherit this
# context, while concurrent discovery and refresh tasks keep their own context.
CONNECTION = ContextVar("ghost_connection", default="usb")


UDID_PATTERN = re.compile(r"[A-Za-z0-9-]{8,80}")
REMOTE_PAIRING_PORT = 49152
NETWORK_CONNECTIONS = ("wifi", "remote")
NETWORK_TIMEOUT = 15.0
# Explicit host for the "remote" connection (for example a Tailscale 100.x address).
REMOTE_HOST = ContextVar("ghost_remote_host", default=None)


def wifi_debug(*parts):
    # Opt-in diagnostics on stderr only (never the protocol stream); no secrets are printed.
    if os.environ.get("GHOST_DEBUG_WIFI"):
        print("network:", *parts, file=sys.stderr, flush=True)


def valid_remote_host(value):
    """An IP literal only: no hostnames (DNS could redirect) and no ports or paths."""
    if not isinstance(value, str) or len(value) > 64:
        return None
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        return None


async def remote_pairing_services(udid=None, bonjour_timeout=4.0):
    """Paired iPhones reachable over the network through RemotePairing (iOS 17.4+).

    Identity: the phone must complete pair-verify against this host's RemotePairing record
    (created once over USB with `pair-remote`). Bonjour answers are matched to records by
    authTag, never by Wi-Fi MAC, so a Private Wi-Fi Address does not matter. iOS only offers
    these services while the phone is joined to some Wi-Fi network; on cellular alone they are
    switched off (hardware-verified on iOS 27.0.1).
    """
    if CONNECTION.get() == "remote":
        host = REMOTE_HOST.get()
        if host is None or udid is None:
            raise ValueError("Enter the iPhone's remote address (for example its Tailscale 100.x IP).")
        service = RemotePairingTunnelService(udid, host, REMOTE_PAIRING_PORT)
        try:
            await asyncio.wait_for(service.connect(autopair=False), NETWORK_TIMEOUT)
        except BaseException as error:
            with suppress(BaseException):
                await service.close()
            if isinstance(error, (KeyboardInterrupt, SystemExit, asyncio.CancelledError)):
                raise
            wifi_debug("remote connect failed", type(error).__name__)
            raise ConnectionError(
                "The iPhone did not answer at that address. Keep it on Wi-Fi with Tailscale on, "
                "and set up remote access over USB first.") from error
        return [service]
    services = await get_remote_pairing_tunnel_services(udid=udid, bonjour_timeout=bonjour_timeout)
    wifi_debug("remotepairing services", len(services))
    return services


async def remote_pairing_service(udid):
    services = await remote_pairing_services(udid=udid)
    for extra in services[1:]:
        with suppress(BaseException):
            await extra.close()
    if not services:
        raise ConnectionError("This iPhone was not found on Wi-Fi. Unlock it, join the same network, "
                              "and set up remote access over USB first.")
    return services[0]


async def connection_lockdown(udid, autopair=False):
    if CONNECTION.get() != "usb":
        raise RuntimeError("This operation needs the iPhone connected by USB.")
    return await usb_lockdown(udid, autopair=autopair)


async def strict_usb_provider(serial, autopair, remotepairing_fallback=False):
    """Use only the requested transport; retain the pinned rootless tunnel lifecycle.

    USB: CoreDeviceProxy over the exact USB lockdown. Network (Wi-Fi or remote): RemotePairing.
    On iOS 27 the phone refuses CoreDeviceProxy tunnel establishment over a network lockdown.
    """
    if CONNECTION.get() in NETWORK_CONNECTIONS:
        return await remote_pairing_service(serial), None
    lockdown = await connection_lockdown(serial, autopair=False)
    try:
        if not lockdown.paired:
            raise RuntimeError("Unlock the iPhone and trust this computer first.")
        return await CoreDeviceTunnelProxy.create(lockdown), lockdown
    except BaseException:
        await lockdown.close()
        raise


userspace_tunnel._create_no_root_tunnel_provider = strict_usb_provider


class Bridge:
    def __init__(self, refresh_interval=REFRESH_INTERVAL, acknowledgement_timeout=LOCATION_ACK_TIMEOUT):
        self.session = None
        self.lock = asyncio.Lock()
        self.refresh_interval = refresh_interval
        self.acknowledgement_timeout = acknowledgement_timeout
        self.target_sequence = 0
        self.transport_error = None

    async def describe(self, lockdown, connection):
        item = {"id": f"ios:{lockdown.udid}", "serial": lockdown.udid,
                "platform": "ios", "name": lockdown.all_values.get("DeviceName") or lockdown.product_type or "iPhone",
                "osVersion": lockdown.product_version, "connection": connection,
                "state": "unauthorized", "detail": "Unlock your iPhone and trust this computer over USB."}
        if not lockdown.paired:
            pass
        elif Version(lockdown.product_version) < Version("17.4"):
            item.update(state="setup-required", detail="This version supports iOS 17.4 or later.")
        elif not await lockdown.get_developer_mode_status():
            item.update(state="setup-required", detail="Enable Developer Mode in Settings → Privacy & Security.")
        else:
            item.update(state="ready", detail=f"{'Wi-Fi' if connection == 'wifi' else 'USB'} connected. Developer Mode enabled.")
        return item

    def describe_remote(self, service, connection):
        info = (service.handshake_info or {}).get("peerDeviceInfo") or {}
        udid = service.remote_identifier
        detail = "Connected remotely through Tailscale." if connection == "remote" else "Connected over Wi-Fi."
        return {"id": f"ios:{udid}", "serial": udid, "platform": "ios",
                "name": str(info.get("name") or "iPhone")[:80], "osVersion": "",
                "connection": connection, "state": "ready",
                "detail": detail}

    async def discover(self, udid=None):
        result = []
        connection = CONNECTION.get()
        if connection in NETWORK_CONNECTIONS:
            if connection == "remote" and not (udid and UDID_PATTERN.fullmatch(udid)):
                return result
            services = []
            try:
                async with asyncio.timeout(NETWORK_TIMEOUT + 5):
                    services = await remote_pairing_services(udid=udid, bonjour_timeout=3.0)
            except (TimeoutError, ConnectionError, OSError) as error:
                wifi_debug("discover", type(error).__name__)
            seen = set()
            for service in services:
                try:
                    if UDID_PATTERN.fullmatch(service.remote_identifier or "") and service.remote_identifier not in seen:
                        seen.add(service.remote_identifier)
                        result.append(self.describe_remote(service, connection))
                finally:
                    with suppress(BaseException):
                        await service.close()
            return result
        for device in await usbmux.list_devices():
            if device.connection_type != "USB":
                continue
            try:
                async with await usb_lockdown(device.serial) as lockdown:
                    result.append(await self.describe(lockdown, "usb"))
            except Exception as error:
                result.append({"id": f"ios:{device.serial}", "serial": device.serial,
                               "platform": "ios", "name": "iPhone", "osVersion": "",
                               "connection": "usb", "state": "unauthorized", "detail": explain(error)})
        return result

    async def enable_wifi(self, udid):
        if self.session and (self.session["udid"] != udid or self.session.get("connection", "usb") != "usb"):
            raise RuntimeError("Select the iPhone that owns the USB session.")
        async with await usb_lockdown(udid, autopair=True) as lockdown:
            if not lockdown.paired:
                raise RuntimeError("Unlock the iPhone and trust this computer first.")
            # Cache the existing trusted record for authenticated Bonjour discovery.
            await lockdown.save_pair_record()
            await lockdown.set_enable_wifi_connections(True)
        return {"enabled": True, "message": "Wi-Fi enabled. Keep both devices on the same network, then choose Wi-Fi in Ghost."}

    async def pair_remote(self, udid):
        """Create this host's RemotePairing record over the trusted USB lockdown (no prompt)."""
        if CONNECTION.get() != "usb":
            raise RuntimeError("Connect the iPhone by USB to set up remote access.")
        async with await usb_lockdown(udid) as lockdown:
            if not lockdown.paired:
                raise RuntimeError("Unlock the iPhone and trust this computer first.")
            service = await RemotePairingLockdownService.create(lockdown)
            try:
                await service.connect(autopair=True)
            except RemotePairingCompletedError:
                pass  # The phone closes the channel once pair-setup completes.
            finally:
                with suppress(BaseException):
                    await service.close()
        return {"paired": True, "message": "Remote access is set up. It appears on the iPhone under Settings → Developer → Paired Computers."}

    async def prepare(self, udid):
        if CONNECTION.get() in NETWORK_CONNECTIONS:
            # Hardware-verified on iOS 27: the developer image cannot be checked or mounted over
            # the network. The image mounted over USB stays until the phone restarts; if it is
            # missing, the DVT connection fails next and is reported as an error, never as success.
            return {"ready": True, "message": "Using the developer image mounted over USB. After the iPhone restarts, connect it by USB once and choose Prepare."}
        async with await connection_lockdown(udid, autopair=True) as lockdown:
            if not lockdown.paired:
                raise RuntimeError("Unlock the iPhone and trust this computer.")
            if Version(lockdown.product_version) < Version("17.4"):
                raise RuntimeError("This version requires iOS 17.4 or later.")
            if not await lockdown.get_developer_mode_status():
                raise RuntimeError("Enable Developer Mode in Settings → Privacy & Security, restart, and confirm it.")
            async with PersonalizedImageMounter(lockdown) as mounter:
                if not await mounter.is_image_mounted("Personalized"):
                    # Keep potentially slow first-run download off the session event loop.
                    image, manifest, trustcache = await asyncio.to_thread(fetch_personalized_ddi)
                    with suppress(AlreadyMountedError):
                        await mounter.mount(image, manifest, trustcache)
        return {"ready": True, "message": "iPhone developer services are ready."}

    async def connect(self, udid):
        if self.transport_error:
            raise RuntimeError("The previous iPhone transport did not close completely. Reset the connection to retry.")
        if self.session:
            if self.session["udid"] == udid and self.session.get("connection", "usb") == CONNECTION.get():
                # A new lockdown connection after replug says nothing about the old
                # DVT stream. Check its lifetime both before and after the USB probe.
                session = self.session
                if self.session_usable(session) and CONNECTION.get() in NETWORK_CONNECTIONS:
                    # The live DVT channel is the only meaningful network liveness signal.
                    return session
                if self.session_usable(session):
                    try:
                        async with await connection_lockdown(udid):
                            if self.session_usable(session):
                                return session
                    except BaseException:
                        await self.fail_session(session, "iPhone connection ended. Location state is unknown.")
                        raise
                await self.fail_session(session, "iPhone developer connection ended. Location state is unknown.")
            else:
                raise RuntimeError("Restore the active iPhone location before switching devices.")
        await self.prepare(udid)
        stack = AsyncExitStack()
        try:
            tunnel = userspace_tunnel.UserspaceRsdTunnel(serial=udid, autopair=False, remotepairing_fallback=False)
            rsd = await stack.enter_async_context(tunnel)
            if rsd.udid != udid:
                raise RuntimeError("Connected iPhone does not match the selected device.")
            dvt = await stack.enter_async_context(DvtProvider(rsd))
            location = await stack.enter_async_context(LocationSimulation(dvt))
        except BaseException:
            try:
                await asyncio.wait_for(stack.aclose(), 8)
            except BaseException as error:
                self.transport_error = error
                raise
            raise
        session = {"udid": udid, "connection": CONNECTION.get(), "stack": stack, "dvt": dvt, "tunnel": tunnel,
                   "location": location, "active": False, "valid": True, "target": None}
        self.session = session
        session["watcher"] = asyncio.create_task(self.watch_session(session))
        return session

    def session_usable(self, session):
        # _closed is the pinned pymobiledevice3's immediate DTX close flag; wait_disconnected()
        # only completes after socket/channel cleanup, which can take seconds.
        return (self.session is session and session.get("valid", True) and
                not getattr(getattr(session.get("dvt"), "dtx", None), "_closed", False) and
                (not session.get("tunnel") or session["tunnel"].rsd is not None))

    def session_event(self, session, error):
        event = {"event": "session-ended", "deviceId": f"ios:{session['udid']}", "error": error}
        target = session.get("target")
        if target:
            event.update(sessionId=target["sessionId"], generation=target["generation"])
        return event

    async def fail_session(self, session, error):
        if self.session is not session:
            return
        event = self.session_event(session, error)
        report = session.get("active") or session.get("target") is not None
        try:
            await self.close_session(clear=False)
        finally:
            if report:
                emit(event)

    async def watch_session(self, session):
        await session["dvt"].dtx.wait_disconnected()
        # Invalidate before waiting for an in-flight request's lock. Replugging
        # must never make this dead stream eligible for reuse.
        session["valid"] = False
        async with self.lock:
            await self.fail_session(session, "iPhone connection ended. Location state is unknown; reconnect to restore it.")

    async def apply_target(self, session, target):
        # The pinned selector has only latitude/longitude, no timestamp argument.
        # The time below records the awaited reply, never a measured GPS fix.
        await asyncio.wait_for(session["location"].set(target["latitude"], target["longitude"]),
                               timeout=self.acknowledgement_timeout)
        if not self.session_usable(session) or session.get("target") is not target:
            raise ConnectionError("iPhone connection ended before the location acknowledgement was accepted.")
        target["refreshCount"] += 1
        target["refreshedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        return {"deviceId": f"ios:{session['udid']}", "sessionId": target["sessionId"],
                "generation": target["generation"], "latitude": target["latitude"], "longitude": target["longitude"],
                "refreshedAt": target["refreshedAt"], "refreshCount": target["refreshCount"],
                "refreshIntervalMs": round(self.refresh_interval * 1000)}

    async def refresh_session(self, session):
        while True:
            await asyncio.sleep(self.refresh_interval)
            async with self.lock:
                if self.session is not session or not session.get("active"):
                    return
                try:
                    if not self.session_usable(session):
                        raise ConnectionError("iPhone developer transport is closed.")
                    acknowledged = await self.apply_target(session, session["target"])
                    emit({"event": "location-refreshed", **acknowledged})
                except Exception as error:
                    await self.fail_session(session, f"iPhone location refresh failed ({explain(error)}). Location state is unknown; reconnect to retry.")
                    return

    async def close_session(self, clear):
        session, self.session = self.session, None
        if not session:
            return
        session["valid"] = False
        tasks = [session[name] for name in ("watcher", "refresher")
                 if session.get(name) and session[name] is not asyncio.current_task()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        try:
            if clear and session["active"]:
                await asyncio.wait_for(session["location"].clear(), self.acknowledgement_timeout)
                session["active"] = False
        finally:
            try:
                await asyncio.wait_for(session["stack"].aclose(), 8)
            except BaseException as error:
                # Upstream owns a process-global tunnel singleton. If its cleanup
                # fails, a fresh process is required before any reconnect attempt.
                self.transport_error = error
                raise

    async def dispatch(self, method, params):
        connection = params.get("connection", "usb")
        if connection not in ("usb", "wifi", "remote"):
            raise ValueError("Choose USB, Wi-Fi or remote.")
        host = None
        if connection == "remote":
            host = valid_remote_host(params.get("host"))
            if host is None:
                raise ValueError("Enter the iPhone's remote IP address (for example its Tailscale 100.x address).")
        token = CONNECTION.set(connection)
        host_token = REMOTE_HOST.set(host)
        try:
            return await self._dispatch(method, params)
        finally:
            REMOTE_HOST.reset(host_token)
            CONNECTION.reset(token)

    async def _dispatch(self, method, params):
        if method == "status":
            version = importlib.metadata.version("pymobiledevice3")
            return {"available": version == PINNED_VERSION, "message": f"iPhone support {version}; iOS 17.4+ over USB or paired Wi-Fi.",
                    "protocolVersion": PROTOCOL_VERSION}
        # Discovery opens independent lockdown connections. It
        # must not pause the persistent DVT refresh loop behind slow trust probes.
        if method == "discover":
            udid = params.get("udid")
            return await self.discover(udid if isinstance(udid, str) else None)
        async with self.lock:
            if method == "pair-remote":
                return await self.pair_remote(params.get("udid"))
            if method == "enable-wifi":
                return await self.enable_wifi(params.get("udid"))
            if method == "prepare":
                return await self.prepare(params.get("udid"))
            if method == "set":
                lat, lon = params.get("latitude"), params.get("longitude")
                if (isinstance(lat, bool) or isinstance(lon, bool) or
                    not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)) or
                    not math.isfinite(lat) or not math.isfinite(lon) or abs(lat) > 90 or abs(lon) > 180):
                    raise ValueError("Invalid latitude or longitude.")
                session_id = params.get("sessionId")
                if session_id is not None and (not isinstance(session_id, str) or len(session_id) > 200):
                    raise ValueError("Invalid location session identifier.")
                session = await self.connect(params.get("udid"))
                self.target_sequence += 1
                target = {"latitude": lat, "longitude": lon, "sessionId": session_id,
                          "generation": params.get("generation", self.target_sequence), "refreshCount": 0}
                # Replace the whole intent while holding the same lock as refresh.
                # A prior coordinate can never be sent after this update begins.
                session["target"] = target
                try:
                    acknowledged = await self.apply_target(session, target)
                    session["active"] = True
                    if not session.get("refresher") or session["refresher"].done():
                        session["refresher"] = asyncio.create_task(self.refresh_session(session))
                    return {"applied": True, **acknowledged}
                except BaseException:
                    await self.fail_session(session, "Location update failed. Location state is unknown; reconnect to restore it.")
                    raise
            if method == "clear":
                session = await self.connect(params.get("udid"))
                try:
                    await asyncio.wait_for(session["location"].clear(), self.acknowledgement_timeout)
                    session["active"] = False
                except BaseException:
                    emit(self.session_event(session, "Restore command failed. Location state is unknown; reconnect to restore it."))
                    raise
                finally:
                    await self.close_session(clear=False)
                return {"cleared": True, "message": "Restore command sent to the iPhone."}
            if method == "reset":
                if self.session and self.session["udid"] != params.get("udid"):
                    raise ValueError("The selected iPhone does not own the current session.")
                await self.close_session(clear=False)
                if self.transport_error:
                    raise RuntimeError("iPhone transport cleanup failed; restart the sidecar before reconnecting.")
                return {"reset": True, "message": "Developer transport closed; the next request creates a fresh connection."}
            if method == "shutdown":
                # A normal quit may explicitly preserve an unresolved session journal
                # without sending another restore command. Closing the transport does
                # not guarantee the OS will retain (or clear) the simulated location.
                await self.close_session(clear=params.get("restore", True) is not False)
                return {"stopped": True}
            raise ValueError("Unknown iPhone operation.")


async def main():
    bridge = Bridge()
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            request = {}
            try:
                if len(line) > 32768:
                    raise ValueError("Request is too large.")
                request = json.loads(line)
                if not isinstance(request, dict) or not isinstance(request.get("params", {}), dict):
                    request = {}
                    raise ValueError("Invalid request.")
                method = request.get("method")
                result = await bridge.dispatch(method, request.get("params", {}))
                emit({"id": request.get("id"), "ok": True, "result": result})
                if method == "shutdown":
                    break
            except Exception as error:
                emit({"id": request.get("id"), "ok": False, "error": explain(error)})
    finally:
        with suppress(Exception):
            await asyncio.wait_for(bridge.close_session(clear=True), 8)


if __name__ == "__main__":
    if importlib.metadata.version("pymobiledevice3") != PINNED_VERSION:
        raise RuntimeError(f"This bridge requires pymobiledevice3 {PINNED_VERSION}.")
    asyncio.run(main())
