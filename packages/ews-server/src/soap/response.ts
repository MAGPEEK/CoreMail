import { create } from 'xmlbuilder2';

const NS_SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const NS_MESSAGES = 'http://schemas.microsoft.com/exchange/services/2006/messages';
const NS_TYPES = 'http://schemas.microsoft.com/exchange/services/2006/types';

export function soapEnvelope(bodyFn: (body: ReturnType<typeof create>) => void): string {
  const doc = create({ version: '1.0', encoding: 'utf-8' })
    .ele('soap:Envelope', {
      'xmlns:soap': NS_SOAP,
      'xmlns:m': NS_MESSAGES,
      'xmlns:t': NS_TYPES,
    })
    .ele('soap:Body');

  bodyFn(doc);

  return doc.root().end({ prettyPrint: false });
}

export function responseClass(success: boolean): string {
  return success ? 'Success' : 'Error';
}

export function errorResponse(action: string, code: string, message: string): string {
  return soapEnvelope((body) => {
    body
      .ele(`m:${action}Response`)
      .ele('m:ResponseMessages')
      .ele(`m:${action}ResponseMessage`, { ResponseClass: 'Error' })
      .ele('m:MessageText').txt(message).up()
      .ele('m:ResponseCode').txt(code).up()
      .ele('m:DescriptiveLinkKey').txt('0').up();
  });
}
