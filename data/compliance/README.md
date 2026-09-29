# Compliance database

Researched filing rules for every country the calendar tool covers, each
checked against its official source. Calendars are built only from these
files (`lib/complianceDb.js`); there is no AI research. Every answer the
forms accept is covered, which `tests/compliance-db.test.js` checks.

| File | Covers |
| --- | --- |
| `united-states.json` | Federal filings by tax status; every state and DC: annual reports, franchise and income tax returns, payroll (withholding, unemployment insurance, paid leave) |
| `canada.json` | Federal filings; each province and territory: annual returns, extra-provincial registrations, Quebec/Alberta corporate tax, provincial sales tax, employer health tax, workers' compensation |
| `united-kingdom.json` | Companies House and HMRC (UK-wide) |
| `singapore.json` | ACRA, IRAS, CPF |
| `united-arab-emirates.json` | Federal (Corporate Tax, VAT, UBO), each emirate's mainland licensing, and each free zone |
| `germany.json` | Accounts publication, corporate/trade tax, VAT, payroll |
| `india-odi.json` | RBI filings by an Indian investor with an overseas direct investment (added to any country) |

## Item format

```json
{
  "id": "uk-ct600",
  "category": "Mandatory Annual",
  "name": "Company Tax Return (CT600)",
  "schedule": { "type": "fy_relative", "monthsAfter": 12, "day": "last" },
  "rule": "12 months after the end of the accounting period",
  "applies": "Every company within the charge to Corporation Tax",
  "description": "…",
  "authority": "HM Revenue & Customs (HMRC)",
  "source": "https://www.gov.uk/company-tax-returns",
  "confidence": "high",
  "when": { "entityType": ["Private Limited Company (Ltd)"] }
}
```

- `category`: Mandatory Annual, Conditional, Transfer Pricing, Foreign Reporting (ODI/FEMA) or Event-Based.
- `schedule`: how the due date is calculated (see the schedule types at the top of `lib/deadlines.js`); `null` when staff set the date.
- `rule`: the due-date wording shown on the calendar.
- `confidence`: `high` when checked against the official source; `medium` when staff should confirm.
- `when`: the item only applies if every condition holds. Keys are the company's answers
  (`entityType`, `taxStatus`, `incorporation`, `zoneType`, `freeZone`, `salesTax`, `vat`,
  `gst`, `hasEmployees`, `employeeBand`, `foreignOwned`, `investorType`, `provincialHome`);
  a list means "one of these", `true`/`false` must match, and `not` negates a group.

## Where items go

- `items`: nationwide.
- `regions[name].items`: the company's own state, province or emirate.
- `regions[name].employerItems`: every region where employees work.
- `regions[name].operatingItems` (Canada): every province where the business operates.
- `regions[name].extraProvincialItems` (Canada): provinces where a corporation from elsewhere is registered (including the home province of a federal corporation).
- `freeZones[name].items` (UAE): companies licensed by that free zone.

## Changing the data

Edit the JSON, then run `npm test`: `tests/compliance-db.test.js` checks every
item and every combination of answers the forms offer. New questions go in
`lib/countries.js` (the forms render them automatically) and are mapped to
facts in `factsFor()` in `lib/complianceDb.js`.
