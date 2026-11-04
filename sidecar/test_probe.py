# SPDX-License-Identifier: GPL-3.0-or-later
"""Persistence probe helper tests; every device call is replaced, no phone access."""
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import persistence_probe as probe


class FakeService:
    def __init__(self, sink):
        self.sink = sink

    async def sendall(self, data):
        self.sink.append(data)


class ProbeTests(unittest.IsolatedAsyncioTestCase):
    def test_parser_requires_explicit_udid_and_valid_coordinates(self):
        with self.assertRaises(SystemExit):
            probe.parser().parse_args(["legacy-set", "--lat", "1", "--lon", "2"])
        with self.assertRaises(SystemExit):
            probe.parser().parse_args(["legacy-set", "--udid", "00008030-000", "--lat", "91", "--lon", "2"])
        args = probe.parser().parse_args(["legacy-set", "--udid", "00008030-000", "--lat", "1.5", "--lon", "-2"])
        self.assertEqual((args.lat, args.lon, args.via), (1.5, -2.0, "usbmux"))

    def test_service_name_override_keeps_upstream_protocol(self):
        provider = SimpleNamespace()
        client = probe.legacy_client(provider, "com.apple.dt.simulatelocation.shim.remote")
        self.assertIsInstance(client, probe.DtSimulateLocation)
        self.assertEqual(client.SERVICE_NAME, "com.apple.dt.simulatelocation.shim.remote")
        self.assertEqual(probe.legacy_client(provider, probe.LEGACY_SERVICE).SERVICE_NAME, probe.LEGACY_SERVICE)

    async def test_legacy_set_reports_sent_never_acknowledged(self):
        written, names = [], []

        async def start(name):
            names.append(name)
            return FakeService(written)

        provider = SimpleNamespace(start_lockdown_developer_service=start)

        async def fake_with_provider(_udid, _via, action):
            return await action(provider)

        with patch.object(probe, "with_provider", new=fake_with_provider):
            result = await probe.legacy("00008030-000", "usbmux", probe.LEGACY_SERVICE, 1.0, 2.0)
            cleared = await probe.legacy("00008030-000", "usbmux", probe.LEGACY_SERVICE)
        self.assertEqual(result, {"sent": True, "acknowledged": False, "via": "usbmux", "service": probe.LEGACY_SERVICE})
        self.assertTrue(cleared["sent"])
        self.assertEqual(names, [probe.LEGACY_SERVICE, probe.LEGACY_SERVICE])
        self.assertEqual(written[0], b"\x00\x00\x00\x00")  # set opcode
        self.assertEqual(written[-1], b"\x00\x00\x00\x01")  # clear opcode

    async def test_failures_are_reported_not_hidden(self):
        with patch.object(probe, "legacy", new=AsyncMock(side_effect=ConnectionError("USB lost"))):
            with patch.object(probe, "out") as out:
                code = await probe.main(["legacy-clear", "--udid", "00008030-000"])
        self.assertEqual(code, 1)
        self.assertFalse(out.call_args.args[0]["ok"])
        self.assertIn("USB lost", out.call_args.args[0]["error"])


if __name__ == "__main__":
    unittest.main()
