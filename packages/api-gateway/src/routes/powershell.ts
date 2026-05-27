/**
 * PowerShell Remoting — Phase 8
 *
 * Exchange Management Shell (EMS) connects via PowerShell Remoting (WSMan/WS-Management)
 * to /PowerShell/ on Exchange servers. This module implements enough of the protocol to:
 *
 *   1. Respond to WSMan Identify (capability negotiation)
 *   2. Extract the cmdlet name from the SOAP envelope
 *   3. Proxy recognised cmdlets to the EMS REST bridge at /api/v1/admin/ems/cmdlet
 *   4. Return a clear SOAP fault for unsupported cmdlets
 *
 * Protocol: WS-Management (SOAP over HTTP), content-type: application/soap+xml
 *
 * Endpoints:
 *   GET     /PowerShell/   → WSDL / capability document
 *   OPTIONS /PowerShell/   → WSMan preflight
 *   POST    /PowerShell/   → Execute cmdlet
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { createLogger } from '@coremail/core';

const log = createLogger('api:powershell');
export const powershellRouter: RouterType = Router();

// ─── Supported cmdlets (routing table) ───────────────────────────────────────

/** Cmdlets that the EMS REST bridge understands. */
const SUPPORTED_CMDLETS = new Set([
  'Get-Mailbox', 'New-Mailbox', 'Set-Mailbox', 'Remove-Mailbox',
  // v5.6.1: DistributionGroup-Cmdlets entfernt
  'Get-AcceptedDomain', 'New-AcceptedDomain', 'Remove-AcceptedDomain',
  'Get-TransportRule', 'New-TransportRule', 'Set-TransportRule', 'Remove-TransportRule', 'Enable-TransportRule', 'Disable-TransportRule',
  'Get-MailboxStatistics',
  'Get-ResourceMailbox',
]);

// ─── Static responses ─────────────────────────────────────────────────────────

const WSDL_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions
  xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:tns="http://schemas.microsoft.com/powershell/2007"
  targetNamespace="http://schemas.microsoft.com/powershell/2007"
  name="PowerShellRemoting">
  <wsdl:documentation>CoreMail Exchange Management Shell Interface — Phase 8</wsdl:documentation>
  <wsdl:types/>
  <wsdl:message name="CommandRequest"/>
  <wsdl:message name="CommandResponse"/>
  <wsdl:portType name="IPS">
    <wsdl:operation name="Command">
      <wsdl:input message="tns:CommandRequest"/>
      <wsdl:output message="tns:CommandResponse"/>
    </wsdl:operation>
  </wsdl:portType>
  <wsdl:binding name="PSBinding" type="tns:IPS">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
  </wsdl:binding>
  <wsdl:service name="PowerShellService">
    <wsdl:port name="PSPort" binding="tns:PSBinding">
      <soap:address location="/PowerShell/"/>
    </wsdl:port>
  </wsdl:service>
</wsdl:definitions>`;

function soapFault(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Body>
    <s:Fault>
      <s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>${code}</s:Value></s:Subcode></s:Code>
      <s:Reason><s:Text xml:lang="en-US">${message}</s:Text></s:Reason>
    </s:Fault>
  </s:Body>
</s:Envelope>`;
}

function soapSuccess(cmdlet: string, result: unknown): string {
  const json = JSON.stringify(result, null, 2)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:rsp="http://schemas.microsoft.com/wbem/wsman/1/windows/shell">
  <s:Body>
    <rsp:CommandResponse>
      <rsp:Command>${cmdlet}</rsp:Command>
      <rsp:Stream Name="stdout"><![CDATA[${json}]]></rsp:Stream>
      <rsp:CommandState State="http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done">
        <rsp:ExitCode>0</rsp:ExitCode>
      </rsp:CommandState>
    </rsp:CommandResponse>
  </s:Body>
</s:Envelope>`;
}

function wsmanIdentifyResponse(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope
  xmlns:s="http://www.w3.org/2003/05/soap-envelope"
  xmlns:wsmid="http://schemas.dmtf.org/wbem/wsman/identity/1/wsmanidentity.xsd">
  <s:Body>
    <wsmid:IdentifyResponse>
      <wsmid:ProtocolVersion>http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd</wsmid:ProtocolVersion>
      <wsmid:ProductVendor>CoreMail</wsmid:ProductVendor>
      <wsmid:ProductVersion>CoreMail 0.9.0 — EMS Phase 8</wsmid:ProductVersion>
      <wsmid:SecurityProfiles>
        <wsmid:SecurityProfileName>http://schemas.dmtf.org/wbem/wsman/1/wsman/secprofile/http/basic</wsmid:SecurityProfileName>
      </wsmid:SecurityProfiles>
    </wsmid:IdentifyResponse>
  </s:Body>
</s:Envelope>`;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

powershellRouter.get('/', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  res.send(WSDL_RESPONSE);
});

powershellRouter.options('/', (_req: Request, res: Response) => {
  res.setHeader('Allow', 'GET,POST,OPTIONS');
  res.setHeader('MS-WSMAN', '1.0');
  res.status(200).end();
});

powershellRouter.post('/', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/soap+xml; charset=utf-8');

  const body = (req.body as string | Buffer).toString();

  // ── WSMan Identify ──────────────────────────────────────────────────────
  if (body.includes('Identify') && body.includes('wsman/identity')) {
    res.send(wsmanIdentifyResponse());
    return;
  }

  // ── Extract cmdlet name from SOAP envelope ───────────────────────────────
  const cmdletMatch = /<rsp:Command(?:\s[^>]*)?>([^<]+)<\/rsp:Command>/i.exec(body);
  const cmdlet = cmdletMatch?.[1]?.trim() ?? '';

  if (!cmdlet) {
    res.send(
      soapFault('wsman:SchemaValidationError', 'Could not extract cmdlet name from request.'),
    );
    return;
  }

  log.info({ cmdlet }, 'PowerShell cmdlet request');

  // ── Route to EMS REST bridge if supported ────────────────────────────────
  if (SUPPORTED_CMDLETS.has(cmdlet)) {
    // Extract parameters from <rsp:Arguments> (best-effort XML text extraction)
    const argsMatch = /<rsp:Arguments(?:\s[^>]*)?>([^<]*)<\/rsp:Arguments>/i.exec(body);
    const rawArgs = argsMatch?.[1]?.trim() ?? '{}';
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      // Arguments may be non-JSON (e.g. raw PowerShell parameter string) — ignore
    }

    try {
      // Internal fetch to the EMS REST bridge on localhost
      const emsUrl = `http://localhost:${process.env['API_PORT'] ?? '3000'}/api/v1/admin/ems/cmdlet`;
      const emsRes = await fetch(emsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Forward the original Authorization header so requireAdmin passes
          ...(req.headers['authorization']
            ? { Authorization: req.headers['authorization'] as string }
            : {}),
        },
        body: JSON.stringify({ cmdlet, params }),
      });

      if (!emsRes.ok) {
        const errText = await emsRes.text();
        res.send(
          soapFault('ems:ExecutionError', `EMS REST bridge returned ${emsRes.status}: ${errText}`),
        );
        return;
      }

      const result = await emsRes.json();
      res.send(soapSuccess(cmdlet, result));
    } catch (err) {
      log.error({ err, cmdlet }, 'EMS REST bridge call failed');
      res.send(
        soapFault('ems:InternalError', `Internal error executing cmdlet '${cmdlet}'.`),
      );
    }
    return;
  }

  // ── Unsupported cmdlet ───────────────────────────────────────────────────
  res.send(
    soapFault(
      'wsman:SchemaValidationError',
      `Cmdlet '${cmdlet}' is not supported by CoreMail EMS. ` +
      `Supported cmdlets: ${[...SUPPORTED_CMDLETS].join(', ')}.`,
    ),
  );
});
