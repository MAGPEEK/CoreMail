// Geteilte Type-Definitionen für Mail-Rules (Frontend)

export type RuleField =
  | 'from' | 'to' | 'cc' | 'bcc' | 'subject' | 'body' | 'recipient'
  | 'hasAttachment' | 'size' | 'importance' | 'sentOnlyToMe';

export type RuleOperator =
  | 'contains' | 'notContains' | 'equals' | 'notEquals'
  | 'startsWith' | 'endsWith' | 'regex'
  | 'greaterThan' | 'lessThan' | 'is';

export interface RuleCondition {
  field: RuleField;
  operator: RuleOperator;
  value: string | number | boolean;
}

export type RuleAction =
  | { type: 'moveTo';        folderId: string }
  | { type: 'copyTo';        folderId: string }
  | { type: 'delete' }
  | { type: 'hardDelete' }
  | { type: 'markRead' }
  | { type: 'markFlagged' }
  | { type: 'pin' }
  | { type: 'categorize';    categoryId: string }
  | { type: 'forward';       address: string }
  | { type: 'redirect';      address: string }
  | { type: 'markJunk' }
  | { type: 'setImportance'; value: 'high' | 'normal' | 'low' };

export interface MailRule {
  id: string;
  userId: string;
  name: string;
  enabled: boolean;
  priority: number;
  conditions: RuleCondition[];
  exceptions: RuleCondition[];
  actions: RuleAction[];
  stopProcessing: boolean;
  matchAll: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RulePreset {
  fromAddr?: string;
  subject?: string;
  toAddr?: string;
}
