/**
 * v5.3.0 — Well-Known Native-Client Auto-Provisioning
 *
 * Outlook 2024 LTSC und andere Microsoft-Clients senden bei OAuth2-Anfragen
 * fest verdrahtete `client_id`-Werte (Outlook's „native app client_id").
 * Damit unser OAuth2-Server diese Clients akzeptiert müssen entsprechende
 * OAuthClient-Einträge in der DB vorhanden sein.
 *
 * Diese Funktion wird beim Boot von api-gateway aufgerufen und legt die
 * Einträge idempotent an (upsert). User-Anpassungen an existierenden
 * Einträgen werden nicht überschrieben (wir checken vorher mit findUnique).
 */

import { prisma } from './prisma/index.js';

interface WellKnownClient {
  clientId:        string;
  name:            string;
  redirectUris:    string[];
  allowedScopes:   string[];
  description:     string;
}

/**
 * Liste der bekannten Native-Client-IDs für Microsoft + Apple Mail-Apps.
 *
 * Quelle: Microsoft ADFS-Setup-Dokumentation +
 * https://learn.microsoft.com/en-us/exchange/plan-and-deploy/post-installation-tasks/enable-modern-auth-in-exchange-server-on-premises
 *
 * ACHTUNG: Diese IDs sind weltweit konstant (von Microsoft fest vergeben).
 * Sie sind PUBLIC clients — kein Secret, PKCE-Pflicht.
 */
const WELL_KNOWN_CLIENTS: readonly WellKnownClient[] = [
  {
    clientId:    'd3590ed6-52b3-4102-aeff-aad2292ab01c',
    name:        'Microsoft Outlook (Win32 + Mac)',
    description: 'Outlook Desktop für Windows + macOS — verwendet diese client_id fest hinterlegt im Build',
    redirectUris: [
      'ms-appx-web://Microsoft.AAD.BrokerPlugin/d3590ed6-52b3-4102-aeff-aad2292ab01c',
      'msauth.com.microsoft.Outlook://auth',
      'urn:ietf:wg:oauth:2.0:oob',
      'https://login.microsoftonline.com/common/oauth2/nativeclient',
    ],
    allowedScopes: [
      'openid', 'profile', 'email', 'offline_access',
      'EWS.AccessAsUser.All',
      'EAS.AccessAsUser.All',
      'Mail.Read', 'Mail.ReadWrite', 'Mail.Send',
      'Calendars.Read', 'Calendars.ReadWrite',
      'Contacts.Read', 'Contacts.ReadWrite',
      // Microsoft-Graph-Style API-Scopes
      'https://outlook.office365.com/.default',
      'https://outlook.office365.com/EWS.AccessAsUser.All',
    ],
  },
  {
    clientId:    '27922004-5251-4030-b22d-91ecd9a37ea4',
    name:        'Microsoft Outlook Mobile (iOS + Android)',
    description: 'Outlook Mobile App — verwendet diese client_id fest hinterlegt im Build',
    redirectUris: [
      'msauth.com.microsoft.Office.Outlook://auth',
      'urn:ietf:wg:oauth:2.0:oob',
    ],
    allowedScopes: [
      'openid', 'profile', 'email', 'offline_access',
      'EWS.AccessAsUser.All',
      'EAS.AccessAsUser.All',
      'Mail.Read', 'Mail.ReadWrite', 'Mail.Send',
      'Calendars.Read', 'Calendars.ReadWrite',
      'Contacts.Read', 'Contacts.ReadWrite',
    ],
  },
  {
    clientId:    'f8d98a96-0999-43f5-8af3-69971c7bb423',
    name:        'iOS Mail.app',
    description: 'Apple Mail auf iOS — verwendet diese client_id für Modern Auth',
    redirectUris: [
      'msauth.com.apple.mobilemail://auth',
      'urn:ietf:wg:oauth:2.0:oob',
    ],
    allowedScopes: [
      'openid', 'profile', 'email', 'offline_access',
      'EAS.AccessAsUser.All',
      'EWS.AccessAsUser.All',
    ],
  },
  {
    clientId:    '00000003-0000-0000-c000-000000000000',
    name:        'Microsoft Graph (Catch-All)',
    description: 'Microsoft Graph API public client_id — fallback für moderne MS-Apps',
    redirectUris: [
      'urn:ietf:wg:oauth:2.0:oob',
      'https://login.microsoftonline.com/common/oauth2/nativeclient',
    ],
    allowedScopes: [
      'openid', 'profile', 'email', 'offline_access',
      'Mail.Read', 'Mail.ReadWrite', 'Mail.Send',
      'Calendars.Read', 'Calendars.ReadWrite',
      'Contacts.Read', 'Contacts.ReadWrite',
      'EWS.AccessAsUser.All',
    ],
  },
];

/**
 * Provisioniert die well-known OAuth2-Clients idempotent. Beim ersten Boot
 * werden alle Einträge angelegt. Bei späteren Boots:
 *   - Existierender Eintrag mit gleicher clientId → unverändert lassen
 *     (User könnte Felder manuell angepasst haben, z.B. weitere scopes)
 *   - Fehlender Eintrag → anlegen
 *
 * Liefert Anzahl neu-angelegter Clients zurück (für Logging).
 */
export async function provisionWellKnownOAuthClients(): Promise<number> {
  let created = 0;
  for (const wkc of WELL_KNOWN_CLIENTS) {
    const existing = await prisma.oAuthClient.findUnique({
      where: { clientId: wkc.clientId },
    }).catch(() => null);
    if (existing) continue;
    await prisma.oAuthClient.create({
      data: {
        clientId:      wkc.clientId,
        name:          wkc.name,
        description:   wkc.description,
        // Public Client — KEIN Secret. PKCE ist Pflicht.
        clientSecret:  '',
        redirectUris:  wkc.redirectUris,
        allowedScopes: wkc.allowedScopes,
        // Microsoft Native Clients sind „trusted" (Outlook zeigt selbst Consent,
        // wir prompt'en nicht zusätzlich). Plus PKCE ist obligatorisch.
        trusted:       true,
        pkceRequired:  true,
        active:        true,
        // Sentinel-User-ID — kennzeichnet auto-provisionierte Clients
        // (im Gegensatz zu User-erstellten via BCP).
        createdBy:     'system',
      },
    }).catch(() => { /* Race-condition: anderer Service hat es gerade angelegt */ });
    created++;
  }
  return created;
}

/**
 * Listet alle Well-Known-Client-IDs (für Logging/Diagnostik).
 */
export function getWellKnownClientIds(): readonly string[] {
  return WELL_KNOWN_CLIENTS.map((c) => c.clientId);
}
