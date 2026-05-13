/**
 * PowerShell Remoting Stub — Phase 7
 *
 * Exchange Management Shell (EMS) connects via PowerShell Remoting (WSMan/WS-Management)
 * to /PowerShell/ on Exchange servers. This stub implements just enough of the protocol
 * to satisfy the EMS client and return meaningful error messages, while keeping the
 * door open for a full implementation in Phase 8.
 *
 * Protocol: WS-Management (SOAP over HTTP), content-type: application/soap+xml
 *
 * Endpoints:
 *   GET  /PowerShell/           → WSDL / capability doc
 *   POST /PowerShell/           → Execute cmdlet (returns stub response)
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';

export const powershellRouter: RouterType = Router();

const WSDL_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions
  xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  targetNamespace="http://schemas.microsoft.com/powershell/2007"
  name="PowerShellRemoting">
  <wsdl:documentation>CoreMail Exchange Management Shell Interface (Stub)</wsdl:documentation>
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

// SOAP fault template for unsupported cmdlets
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

// Capability response for WSMan identification
function wsmanIdentifyResponse(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope
  xmlns:s="http://www.w3.org/2003/05/soap-envelope"
  xmlns:wsmid="http://schemas.dmtf.org/wbem/wsman/identity/1/wsmanidentity.xsd">
  <s:Body>
    <wsmid:IdentifyResponse>
      <wsmid:ProtocolVersion>http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd</wsmid:ProtocolVersion>
      <wsmid:ProductVendor>CoreMail</wsmid:ProductVendor>
      <wsmid:ProductVersion>CoreMail 0.8.0 Exchange PS Stub</wsmid:ProductVersion>
      <wsmid:SecurityProfiles>
        <wsmid:SecurityProfileName>http://schemas.dmtf.org/wbem/wsman/1/wsman/secprofile/http/basic</wsmid:SecurityProfileName>
      </wsmid:SecurityProfiles>
    </wsmid:IdentifyResponse>
  </s:Body>
</s:Envelope>`;
}

// GET /PowerShell/ — return WSDL
powershellRouter.get('/', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  res.send(WSDL_RESPONSE);
});

// OPTIONS /PowerShell/ — WSMan preflight
powershellRouter.options('/', (_req: Request, res: Response) => {
  res.setHeader('Allow', 'GET,POST,OPTIONS');
  res.setHeader('MS-WSMAN', '1.0');
  res.status(200).end();
});

// POST /PowerShell/ — handle WSMan requests
powershellRouter.post('/', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/soap+xml; charset=utf-8');

  const body = (req.body as string | Buffer).toString();

  // WSMan Identify request
  if (body.includes('Identify') && body.includes('wsman/identity')) {
    res.send(wsmanIdentifyResponse());
    return;
  }

  // Extract cmdlet name from the SOAP body if present (best-effort)
  const cmdletMatch = /<rsp:CommandLine[^>]*>.*?<rsp:Command>(.*?)<\/rsp:Command>/s.exec(body);
  const cmdlet = cmdletMatch?.[1]?.trim() ?? 'unknown';

  // For all other requests, return a clear SOAP fault indicating stub mode
  res.status(200).send(
    soapFault(
      'wsman:SchemaValidationError',
      `Cmdlet '${cmdlet}' is not implemented in the CoreMail PowerShell stub. ` +
      'This endpoint accepts WSMan protocol connections but only provides ' +
      'informational responses. Full EMS support is planned for Phase 8.',
    ),
  );
});
