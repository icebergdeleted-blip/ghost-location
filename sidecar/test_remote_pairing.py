# SPDX-License-Identifier: GPL-3.0-or-later
"""Network (Wi-Fi / remote) transport via RemotePairing; every device call is replaced."""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import ios_bridge as bridge_module

PHONE = "00008140-000244AE1132801C"


def service(identifier=PHONE, name="Test iPhone"):
    return SimpleNamespace(remote_identifier=identifier, hostname="10.0.0.5",
                           handshake_info={"peerDeviceInfo": {"name": name}},
                           connect=AsyncMock(), close=AsyncMock())


class NetworkContext:
    def __init__(self, connection, host=None):
        self.connection, self.host = connection, host

    def __enter__(self):
        self.tokens = (bridge_module.CONNECTION.set(self.connection), bridge_module.REMOTE_HOST.set(self.host))

    def __exit__(self, *exc):
        bridge_module.REMOTE_HOST.reset(self.tokens[1])
        bridge_module.CONNECTION.reset(self.tokens[0])


class RemotePairingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.deadline = asyncio.timeout(5)  # A hang fails fast instead of stalling the suite.
        await self.deadline.__aenter__()

    async def asyncTearDown(self):
        await self.deadline.__aexit__(None, None, None)

    async def test_wifi_tunnel_uses_remotepairing_and_never_usb(self):
        selected, other = service(), service()
        with NetworkContext("wifi"), \
                patch.object(bridge_module, "get_remote_pairing_tunnel_services", AsyncMock(return_value=[selected, other])) as find, \
                patch.object(bridge_module, "usb_lockdown", AsyncMock()) as usb:
            provider, lockdown = await bridge_module.strict_usb_provider(PHONE, True, True)
        self.assertIs(provider, selected)
        self.assertIsNone(lockdown)
        self.assertEqual(find.await_args.kwargs["udid"], PHONE)
        other.close.assert_awaited_once()
        usb.assert_not_awaited()

    async def test_missing_wifi_phone_is_an_error_not_a_usb_fallback(self):
        with NetworkContext("wifi"), \
                patch.object(bridge_module, "get_remote_pairing_tunnel_services", AsyncMock(return_value=[])), \
                patch.object(bridge_module, "usb_lockdown", AsyncMock()) as usb:
            with self.assertRaisesRegex(ConnectionError, "not found on Wi-Fi"):
                await bridge_module.strict_usb_provider(PHONE, False)
        usb.assert_not_awaited()

    async def test_remote_host_connects_directly_without_autopair_or_bonjour(self):
        created = service()
        factory = MagicMock(return_value=created)
        with NetworkContext("remote", "100.64.0.7"), patch.object(bridge_module, "RemotePairingTunnelService", factory), \
                patch.object(bridge_module, "get_remote_pairing_tunnel_services", AsyncMock()) as bonjour:
            provider, _ = await bridge_module.strict_usb_provider(PHONE, True)
        self.assertIs(provider, created)
        factory.assert_called_once_with(PHONE, "100.64.0.7", 49152)
        created.connect.assert_awaited_once_with(autopair=False)
        bonjour.assert_not_awaited()

    async def test_unreachable_remote_host_closes_and_reports_honestly(self):
        failing = service()
        failing.connect = AsyncMock(side_effect=ConnectionRefusedError("refused"))
        with NetworkContext("remote", "100.64.0.7"), \
                patch.object(bridge_module, "RemotePairingTunnelService", MagicMock(return_value=failing)):
            with self.assertRaisesRegex(ConnectionError, "did not answer"):
                await bridge_module.strict_usb_provider(PHONE, False)
        failing.close.assert_awaited()

    async def test_remote_requires_an_ip_literal_host(self):
        bridge = bridge_module.Bridge()
        for host in (None, "", "phone.ts.net", "100.64.0.7:49152", "http://100.64.0.7", "1" * 70):
            with self.assertRaisesRegex(ValueError, "remote IP address"):
                await bridge.dispatch("discover", {"connection": "remote", "host": host, "udid": PHONE})
        self.assertEqual(bridge_module.valid_remote_host(" fd7a:115c:a1e0::1 "), "fd7a:115c:a1e0::1")
        with self.assertRaisesRegex(ValueError, "Choose USB, Wi-Fi or remote"):
            await bridge.dispatch("discover", {"connection": "bluetooth"})

    async def test_network_discovery_deduplicates_describes_and_closes(self):
        first, duplicate, invalid = service(), service(), service(identifier="bad id!")
        with patch.object(bridge_module, "get_remote_pairing_tunnel_services",
                          AsyncMock(return_value=[first, duplicate, invalid])):
            result = await bridge_module.Bridge().dispatch("discover", {"connection": "wifi"})
        self.assertEqual([item["id"] for item in result], [f"ios:{PHONE}"])
        self.assertEqual((result[0]["state"], result[0]["connection"], result[0]["name"]), ("ready", "wifi", "Test iPhone"))
        for item in (first, duplicate, invalid):
            item.close.assert_awaited_once()

    async def test_remote_discovery_needs_the_selected_phone(self):
        with patch.object(bridge_module, "RemotePairingTunnelService", MagicMock()) as factory:
            result = await bridge_module.Bridge().dispatch("discover", {"connection": "remote", "host": "100.64.0.7"})
        self.assertEqual(result, [])
        factory.assert_not_called()

    async def test_unreachable_phone_discovers_nothing_instead_of_failing(self):
        with patch.object(bridge_module, "get_remote_pairing_tunnel_services", AsyncMock(side_effect=OSError("down"))):
            self.assertEqual(await bridge_module.Bridge().dispatch("discover", {"connection": "wifi"}), [])

    async def test_network_prepare_never_touches_lockdown_or_the_image_mounter(self):
        with NetworkContext("remote", "100.64.0.7"), \
                patch.object(bridge_module, "usb_lockdown", AsyncMock()) as usb, \
                patch.object(bridge_module, "PersonalizedImageMounter", MagicMock(side_effect=AssertionError)) as mounter:
            result = await bridge_module.Bridge().prepare(PHONE)
        self.assertTrue(result["ready"])
        self.assertIn("USB", result["message"])
        usb.assert_not_awaited()
        mounter.assert_not_called()

    async def test_lockdown_operations_are_usb_only(self):
        with NetworkContext("wifi"), patch.object(bridge_module, "usb_lockdown", AsyncMock()) as usb:
            with self.assertRaisesRegex(RuntimeError, "connected by USB"):
                await bridge_module.connection_lockdown(PHONE)
        usb.assert_not_awaited()

    async def test_remote_pairing_setup_is_usb_only_promptless_and_closes(self):
        lockdown = AsyncMock()
        lockdown.paired = True
        lockdown.__aenter__.return_value = lockdown
        channel = SimpleNamespace(connect=AsyncMock(side_effect=bridge_module.RemotePairingCompletedError()),
                                  close=AsyncMock())
        with patch.object(bridge_module, "usb_lockdown", AsyncMock(return_value=lockdown)), \
                patch.object(bridge_module.RemotePairingLockdownService, "create", AsyncMock(return_value=channel)):
            result = await bridge_module.Bridge().dispatch("pair-remote", {"udid": PHONE})
        self.assertTrue(result["paired"])
        channel.connect.assert_awaited_once_with(autopair=True)
        channel.close.assert_awaited_once()
        with self.assertRaisesRegex(RuntimeError, "by USB"):
            await bridge_module.Bridge().dispatch("pair-remote", {"udid": PHONE, "connection": "wifi"})

    async def test_live_network_session_is_reused_without_a_lockdown_probe(self):
        bridge = bridge_module.Bridge()
        session = {"udid": PHONE, "connection": "remote", "valid": True,
                   "dvt": SimpleNamespace(dtx=SimpleNamespace(_closed=False)), "tunnel": None}
        bridge.session = session
        with NetworkContext("remote", "100.64.0.7"), patch.object(bridge_module, "usb_lockdown", AsyncMock()) as usb:
            self.assertIs(await bridge.connect(PHONE), session)
        usb.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
