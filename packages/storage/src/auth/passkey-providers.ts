/**
 * 10.6: display names of common passkey providers by AAGUID (no metadata
 * service — attestation is "none"; the AAGUID is self-reported and used for
 * display only, never for a decision). Unknown → null (the UI shows
 * "synced" / "device-bound" from the BE / BS flags instead).
 */
const PROVIDERS: Readonly<Record<string, string>> = {
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain (Managed)',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  'fdb141b2-5d84-443e-8a35-4698c205a502': 'KeePassXC',
  '50726f74-6f6e-5061-7373-50726f746f6e': 'Proton Pass',
};

export function passkeyProviderName(aaguid: string | null | undefined): string | null {
  return aaguid ? PROVIDERS[aaguid.toLowerCase()] ?? null : null;
}
