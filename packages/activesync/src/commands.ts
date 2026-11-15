/**
 * EAS commands this server implements — advertised in OPTIONS
 * (MS-ASProtocolCommands). Keep in sync with the dispatcher in server.ts: a
 * command is listed only when it has a real handler (no empty-200 stubs).
 */
export const EAS_COMMANDS: readonly string[] = [
  'Sync', 'SendMail', 'SmartForward', 'SmartReply', 'GetAttachment', 'FolderSync',
  'MoveItems', 'MeetingResponse', 'Provision', 'ResolveRecipients', 'Ping', 'Search', 'Settings',
];
