# SPDX-License-Identifier: GPL-3.0-or-later
"""Wi-Fi discovery identity: match by accepted pairing + reported UDID, never by Bonjour MAC."""
import plistlib
import tempfile
import unittest
import unittest.mock
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import ios_bridge as bridge_module

PHONE = "00008140-000244AE1132801C"
OTHER = "00008030-0000000000000002"


def answer(instance, *ips):
    return SimpleNamespace(instance=instance, addresses=[SimpleNamespace(full_ip=ip) for ip in ips])


class WifiIdentityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        bridge_module.VERIFIED_ADDRESSES.clear()
        self.addCleanup(bridge_module.VERIFIED_ADDRESSES.clear)

    async def collect(self, answers, connect, records):
        found = []
        with patch.object(bridge_module, "browse_mobdev2", AsyncMock(return_value=answers)), \
                patch.object(bridge_module, "create_using_tcp", connect):
            async for address, lockdown in bridge_module.wifi_lockdowns(records=records):
                found.append((address, lockdown.udid))
        return found

    async def test_private_wifi_address_phone_is_found_by_pairing_identity(self):
        # Bonjour instance carries a randomized, locally administered MAC unrelated to the record.
        record = {"WiFiMACAddress": "a4:83:e7:00:00:01", "HostID": "host"}
        lockdown = SimpleNamespace(udid=PHONE, paired=True, close=AsyncMock())
        connect = AsyncMock(return_value=lockdown)
        found = await self.collect([answer("6a:12:34:56:78:9a@fe80::1", "fe80::1%Tailscale Tunnel", "192.168.137.208")],
                                   connect, {PHONE: record})
        self.assertEqual(found, [("192.168.137.208", PHONE)])
        # Routable IPv4 is tried before the scoped link-local address, with the matching record.
        self.assertEqual(connect.await_args_list[0].kwargs["hostname"], "192.168.137.208")
        self.assertIs(connect.await_args_list[0].kwargs["pair_record"], record)
        self.assertFalse(connect.await_args_list[0].kwargs["autopair"])

    async def test_unaccepted_record_or_different_udid_is_never_yielded_and_is_closed(self):
        unpaired = SimpleNamespace(udid=PHONE, paired=False, close=AsyncMock())
        impostor = SimpleNamespace(udid=OTHER, paired=True, close=AsyncMock())
        connect = AsyncMock(side_effect=[unpaired, impostor])
        found = await self.collect([answer("x@y", "10.0.0.5", "10.0.0.6")], connect, {PHONE: {}})
        self.assertEqual(found, [])
        unpaired.close.assert_awaited_once()
        impostor.close.assert_awaited_once()

    async def test_reset_or_recursing_address_falls_through_to_the_next(self):
        good = SimpleNamespace(udid=PHONE, paired=True, close=AsyncMock())
        connect = AsyncMock(side_effect=[ConnectionResetError("reset"), RecursionError("loop"), good])
        found = await self.collect([answer("x@y", "100.64.0.9", "10.0.0.7"), answer("x@z", "10.0.0.8")],
                                   connect, {PHONE: {}})
        self.assertEqual(found, [("10.0.0.8", PHONE)])

    async def test_same_phone_on_several_answers_is_yielded_once(self):
        lockdown = SimpleNamespace(udid=PHONE, paired=True, close=AsyncMock())
        connect = AsyncMock(return_value=lockdown)
        found = await self.collect([answer("a@b", "10.0.0.5"), answer("a@b", "10.0.0.5")], connect, {PHONE: {}})
        self.assertEqual(found, [("10.0.0.5", PHONE)])
        self.assertEqual(connect.await_count, 1)

    async def test_no_pair_records_means_no_network_probe(self):
        browse = AsyncMock()
        with patch.object(bridge_module, "browse_mobdev2", browse):
            found = [item async for item in bridge_module.wifi_lockdowns(records={})]
        self.assertEqual(found, [])
        browse.assert_not_awaited()

    async def test_last_verified_address_is_tried_first_without_bonjour(self):
        bridge_module.VERIFIED_ADDRESSES[PHONE] = "10.0.0.5"
        lockdown = SimpleNamespace(udid=PHONE, paired=True, close=AsyncMock())
        browse = AsyncMock(return_value=[])
        with patch.object(bridge_module, "browse_mobdev2", browse),                 patch.object(bridge_module, "create_using_tcp", AsyncMock(return_value=lockdown)):
            found = [(a, l.udid) async for a, l in bridge_module.wifi_lockdowns(records={PHONE: {}})]
        self.assertEqual(found, [("10.0.0.5", PHONE)])
        browse.assert_not_awaited()

    async def test_reused_cached_address_must_prove_identity_or_bonjour_is_used(self):
        bridge_module.VERIFIED_ADDRESSES[PHONE] = "10.0.0.5"  # now another device
        impostor = SimpleNamespace(udid=OTHER, paired=True, close=AsyncMock())
        real = SimpleNamespace(udid=PHONE, paired=True, close=AsyncMock())
        connect = AsyncMock(side_effect=[impostor, real])
        found = await self.collect([answer("x@y", "10.0.0.9")], connect, {PHONE: {}})
        self.assertEqual(found, [("10.0.0.9", PHONE)])
        impostor.close.assert_awaited_once()
        self.assertEqual(bridge_module.VERIFIED_ADDRESSES[PHONE], "10.0.0.9")

    async def test_empty_bonjour_browse_is_retried_once_with_a_longer_window(self):
        lockdown = SimpleNamespace(udid=PHONE, paired=True, close=AsyncMock())
        browse = AsyncMock(side_effect=[[], [answer("x@y", "10.0.0.5")]])
        with patch.object(bridge_module, "browse_mobdev2", browse),                 patch.object(bridge_module, "create_using_tcp", AsyncMock(return_value=lockdown)):
            found = [a async for a, _ in bridge_module.wifi_lockdowns(records={PHONE: {}}, timeout=2)]
        self.assertEqual(found, ["10.0.0.5"])
        self.assertEqual([c.kwargs["timeout"] for c in browse.await_args_list], [2, 4])

    async def test_wifi_prepare_never_touches_the_image_mounter(self):
        lockdown = SimpleNamespace(paired=True, product_version="27.0.1", get_developer_mode_status=AsyncMock(return_value=True))
        lockdown.__aenter__ = AsyncMock(return_value=lockdown)
        context = AsyncMock(); context.__aenter__.return_value = lockdown
        mounter = unittest.mock.MagicMock(side_effect=AssertionError("mounter used over Wi-Fi"))
        token = bridge_module.CONNECTION.set("wifi")
        try:
            with patch.object(bridge_module, "connection_lockdown", AsyncMock(return_value=context)),                     patch.object(bridge_module, "PersonalizedImageMounter", mounter):
                result = await bridge_module.Bridge().prepare(PHONE)
        finally:
            bridge_module.CONNECTION.reset(token)
        self.assertTrue(result["ready"])
        self.assertIn("USB", result["message"])
        mounter.assert_not_called()

    def test_pair_records_load_only_lockdown_udid_files(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, f"{PHONE}.plist").write_bytes(plistlib.dumps({"HostID": "h"}))
            Path(folder, f"remote_{PHONE}.plist").write_bytes(plistlib.dumps({"x": 1}))
            Path(folder, "bad name!.plist").write_bytes(plistlib.dumps({"x": 1}))
            Path(folder, f"{OTHER}.plist").write_bytes(b"not a plist")
            self.assertEqual(list(bridge_module.local_pair_records(folder)), [PHONE])
            self.assertEqual(bridge_module.local_pair_records(folder, udid=OTHER), {})


if __name__ == "__main__":
    unittest.main()
