# Source Chip Component - Usage Guide

## Overview

The `SourceChip` component displays a small badge indicating which account an email came from. It's only shown in the "Everything" view where emails from multiple accounts are merged.

---

## Account Boundary Invariant (read before touching cross-account mail state)

> Any mail item used in a cross-account context is identified by its connected **source account** *and* its **provider-local item ID** together. Bare message or thread IDs must **not** own cross-account state or behavior.

Gmail message/thread IDs are unique only *within* one mailbox — two connected accounts can hold the same provider-local ID. In the Everything view, cross-account search, and batch actions those items coexist, so any map/set/comparison keyed on the bare ID silently collapses them (wrong body/headers, a message hidden from search, a star/selection bleeding across accounts, or a mutation hitting the wrong account's message).

The canonical composite key lives in [`utils/mailIdentity.js`](../utils/mailIdentity.js): `mailKey(accountId, id)`, `threadKey(accountId, threadId)`, `emailKey(email)`, `emailThreadKey(email)`, and `sameMailItem(a, b)`. All cross-account body/header/attachment/prefetch/hydration/star/selection/search-dedup/conversation-grouping state and every active-row / reader / navigation comparison route through these helpers. `emailCache` reuses `mailKey` so its persisted IndexedDB key stays identical.

Rules of thumb:
- Never key a cross-account `Map`/`Set`/object or compare two items by a bare `.id`.
- Optimistic read/archive/delete/label edits are scoped to the acted-on account (`state[accountId]`), never fanned across all accounts by id.
- Mutation URLs come from the original item's own `accountId` + provider id. **Never** reconstruct a target by splitting a serialized key.
- Snooze persistence (`atm_snoozed`, `${accountId}_${id}`) predates this module and keeps its own format — do not migrate it.

---

## Import

```javascript
import SourceChip from './components/SourceChip';
import { getAccountShortLabel } from './utils/getAccountShortLabel';
```

---

## Basic Usage

### In EmailRow Component

```javascript
import SourceChip from './components/SourceChip';

const EmailRow = ({ email, showSourceChip }) => (
  <div className="email-item">
    <div className="email-sender-line">
      <span className="email-sender">{email.from}</span>
      
      {/* Show chip only in Everything view */}
      {showSourceChip && (
        <SourceChip
          accountName={email.accountDisplayName}
          accountId={email.accountId}
        />
      )}
    </div>
    <div className="email-subject">{email.subject}</div>
    <div className="email-snippet">{email.snippet}</div>
  </div>
);
```

### Conditional Rendering

```javascript
const EmailList = ({ activeView, emails }) => {
  const showSourceChip = activeView === 'everything';
  
  return (
    <div className="email-list">
      {emails.map(email => (
        <EmailRow 
          key={email.id}
          email={email}
          showSourceChip={showSourceChip}
        />
      ))}
    </div>
  );
};
```

---

## Props API

### SourceChip Component

| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `accountName` | string | Yes | - | Full account display name (e.g., "Ranger & Fox") |
| `accountId` | string | Yes | - | Unique account identifier |
| `variant` | 'pill' \| 'dot' | No | 'pill' | Visual style of the chip |
| `onClick` | function | No | - | Click handler `(accountId) => void` |

---

## Label Generation Examples

The `getAccountShortLabel` utility automatically generates short labels:

```javascript
getAccountShortLabel("Ranger & Fox")           // → "RF"
getAccountShortLabel("Acme Design Studio")     // → "ADS"
getAccountShortLabel("Notion")                 // → "NOTI"
getAccountShortLabel("john.doe@gmail.com")     // → "JOHN"
getAccountShortLabel("demo-account")           // → "DA"
getAccountShortLabel("Personal Email")         // → "PE"
getAccountShortLabel("my_side_project")        // → "MSP"
getAccountShortLabel("Work")                   // → "WORK"
```

### Algorithm

1. **Multi-word names** → Take first letter of each word (max 4)
2. **Single word** → Take first 4 characters
3. **Email addresses** → Strip domain, then apply above rules
4. **All labels** → Uppercase, 2-6 characters

---

## Styling Variants

### Pill (Default)

```javascript
<SourceChip
  accountName="Ranger & Fox"
  accountId="acc_123"
  variant="pill"
/>
```

Visual: `[RF]` - Subtle pill with background and border

### Dot (Alternative)

```javascript
<SourceChip
  accountName="Ranger & Fox"
  accountId="acc_123"
  variant="dot"
/>
```

Visual: `•` - Simple colored dot (shows tooltip on hover)

---

## Click Handling (Optional)

### Filter by Account on Click

```javascript
const handleChipClick = (accountId) => {
  console.log('Filter to account:', accountId);
  setActiveView(accountId);
};

<SourceChip
  accountName="Ranger & Fox"
  accountId="acc_work"
  onClick={handleChipClick}
/>
```

When `onClick` is provided:
- Chip becomes clickable (cursor pointer)
- Hover shows lime accent
- Click doesn't trigger email selection (stopPropagation)

---

## Display Rules

### When to Show

| View | Show Chips? | Reason |
|------|-------------|--------|
| Everything | ✅ Yes | Multiple accounts merged |
| Single Account | ❌ No | All emails from same account |

```javascript
const showSourceChip = activeView === 'everything';
```

### Visual Priority

Source chips are intentionally **subtle**:
- Lower opacity (0.7)
- Small text (10px)
- Neutral colors
- Positioned after sender name

```
[Sender Name] [Chip]
  ↓ Primary   ↓ Secondary
  Bold 16px   Light 10px
```

---

## Data Structure

### Email Object

```javascript
{
  id: 'msg_123',
  from: 'sarah@company.com',
  subject: 'Q4 Strategy',
  snippet: 'Hey team...',
  
  // Account info for chip
  accountId: 'acc_work_456',
  accountDisplayName: 'Ranger & Fox',
  accountEmail: 'steve@work.com'
}
```

### Account Object

```javascript
{
  id: 'acc_work_456',
  displayName: 'Ranger & Fox',     // Used for chip label
  email: 'steve@work.com',
  color: '#EA4335'                 // Optional future use
}
```

---

## Accessibility

### Tooltips

Hovering a chip shows the full account name:

```javascript
<SourceChip
  accountName="Ranger & Fox"  // Shows "Ranger & Fox" on hover
  accountId="acc_123"
/>
```

### ARIA Labels

```html
<span 
  class="source-chip"
  title="Ranger & Fox"
  aria-label="From Ranger & Fox"
>
  RF
</span>
```

### Keyboard Navigation

When clickable:
- Tab to focus
- Enter/Space to activate
- Focus outline visible

---

## Testing

### Unit Tests

```javascript
import { getAccountShortLabel } from '../utils/getAccountShortLabel';

describe('getAccountShortLabel', () => {
  test('multi-word initials', () => {
    expect(getAccountShortLabel('Ranger & Fox')).toBe('RF');
    expect(getAccountShortLabel('Acme Design Studio')).toBe('ADS');
  });
  
  test('single word truncation', () => {
    expect(getAccountShortLabel('Notion')).toBe('NOTI');
    expect(getAccountShortLabel('Work')).toBe('WORK');
  });
  
  test('email domain removal', () => {
    expect(getAccountShortLabel('john.doe@gmail.com')).toBe('JOHN');
  });
  
  test('special character handling', () => {
    expect(getAccountShortLabel('demo-account')).toBe('DA');
    expect(getAccountShortLabel('my_side_project')).toBe('MSP');
  });
  
  test('edge cases', () => {
    expect(getAccountShortLabel('')).toBe('');
    expect(getAccountShortLabel('a')).toBe('A');
  });
});
```

### Integration Tests

```javascript
test('chips show in Everything view only', () => {
  const { container } = render(
    <EmailList activeView="everything" emails={mockEmails} />
  );
  
  expect(container.querySelectorAll('.source-chip')).toHaveLength(4);
});

test('chips hidden in single account view', () => {
  const { container } = render(
    <EmailList activeView="work" emails={mockEmails} />
  );
  
  expect(container.querySelectorAll('.source-chip')).toHaveLength(0);
});
```

---

## Performance

### Memoization (Optional)

For large email lists, memoize the label generation:

```javascript
import { useMemo } from 'react';

const EmailRow = ({ email, showSourceChip }) => {
  const chipLabel = useMemo(
    () => getAccountShortLabel(email.accountDisplayName),
    [email.accountDisplayName]
  );
  
  return (
    // ... use chipLabel
  );
};
```

### Fixed Height

Source chips have a fixed height (18px) to prevent layout shifts:

```css
.source-chip--pill {
  height: 18px;
  min-width: 24px;
  max-width: 60px;
}
```

---

## Future Enhancements

### Color Coding (Subtle)

```javascript
const chipColors = {
  'acc_work': '#EA4335',
  'acc_personal': '#FBBC04',
  'acc_side': '#34A853'
};

<SourceChip
  accountName="Ranger & Fox"
  accountId="acc_work"
  style={{ borderColor: chipColors[accountId] }}
/>
```

**Note:** Keep very subtle to avoid visual noise

### Account Icons

```javascript
<SourceChip
  accountName="Ranger & Fox"
  accountId="acc_work"
  icon={<img src={account.favicon} />}
/>
```

Shows favicon before label if available

---

## Design Principles

### Badge, Not Tag

- **Badge:** Informational, subtle, low priority
- **Tag:** Actionable, prominent, categorization

We want **badge** behavior:
- Lower visual weight
- Consistent position
- Pure information
- Optional interaction

### Visual Quietness

- Opacity: 0.7 (not full strength)
- Small text: 10px
- Neutral colors
- Border for separation

### Deterministic

Same input always produces same output:

```javascript
getAccountShortLabel('Ranger & Fox')  // Always "RF"
getAccountShortLabel('Ranger & Fox')  // Always "RF"
```

No randomness, no state dependency

---

## Troubleshooting

### Chips Not Showing

Check:
1. Is `activeView === 'everything'`?
2. Is `showSourceChip` prop passed correctly?
3. Does email have `accountDisplayName`?

### Labels Too Long

Algorithm limits to 6 characters:

```javascript
getAccountShortLabel('Very Long Company Name Inc')  // → "VLCNI" (max 6)
```

### Layout Shifts

Ensure CSS has fixed height:

```css
.source-chip--pill {
  height: 18px;  /* Fixed */
}
```

---

## Summary

**Purpose:** Show email provenance in merged inbox  
**Display:** Everything view only  
**Style:** Subtle pill badge  
**Label:** Auto-generated, 2-6 chars, uppercase  
**Interaction:** Optional click to filter  
**Accessibility:** Tooltip + ARIA labels  

---

*Updated: January 28, 2026*  
*Component Version: 1.0*
