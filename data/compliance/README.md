# Compliance database

Researched filing rules for every country the calendar tool covers. Calendars are built only from these
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
| `australia.json` | ASIC and ATO (federal); each state's and territory's payroll tax and workers' compensation |
| `austria.json` | Firmenbuch, tax office and payroll (federal); Vienna's employer levy and the states' tourism contributions |
| `belgium.json` | National Bank accounts filing, corporate tax, VAT, payroll (federal) |
| `denmark.json` | Erhvervsstyrelsen and Skattestyrelsen (national) |
| `france.json` | Greffe, DGFiP and URSSAF (national); payroll duties by headcount |
| `hong-kong.json` | Companies Registry, IRD (profits tax return date by year-end code), MPF |
| `ireland.json` | CRO and Revenue (national) |
| `italy.json` | Business Register, Agenzia delle Entrate, INPS/INAIL; IRAP for each region |
| `japan.json` | National Tax Agency and payroll; each prefecture's inhabitant, enterprise and depreciable assets taxes |
| `netherlands.json` | KVK and Belastingdienst (national) |
| `norway.json` | Brønnøysund registers and Skatteetaten (national) |
| `portugal.json` | AT, Social Security, RCBE; regional rates of Madeira and the Azores |
| `south-korea.json` | NTS, local income tax, the four social insurances |
| `spain.json` | Mercantile Registry and AEAT; the Basque Country's and Navarre's own tax offices, IGIC in the Canary Islands, IPSI in Ceuta and Melilla |
| `sweden.json` | Bolagsverket and Skatteverket (income tax return date by year end) |
| `switzerland.json` | Federal VAT, withholding tax and social insurance; each canton's tax return and tax at source |
| `india-odi.json` | RBI filings by an Indian investor with an overseas direct investment (added to any country) |

The sixteen files added in October 2026 (Australia to Switzerland in the table)
are a first draft that has not yet been checked line by line against the
official sources: every item in them is marked `medium` confidence. Raise an
item to `high` once someone has confirmed it. Swiss cantonal tax return dates
differ by canton and are left without a schedule, so staff set the date.

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
  `gst`, `hasEmployees`, `employeeBand`, `foreignOwned`, `investorType`, `provincialHome`,
  `region`, and `fyEndMonth`: the month the financial year ends, 1-12);
  a list means "one of these", `true`/`false` must match, and `not` negates a group.

## Where items go

- `items`: nationwide.
- `regions[name].items`: the company's own state, province, emirate, canton, prefecture or region.
  A country whose file has `regions` asks for the region and covers only those listed.
- `regions[name].employerItems`: every region where employees work (the home region, plus the
  other regions chosen where the form asks for them).
- `regions[name].operatingItems` (Canada): every province where the business operates.
- `regions[name].extraProvincialItems` (Canada): provinces where a corporation from elsewhere is registered (including the home province of a federal corporation).
- `freeZones[name].items` (UAE): companies licensed by that free zone.

## Changing the data

Edit the JSON, then run `npm test`: `tests/compliance-db.test.js` checks every
item and every combination of answers the forms offer. New questions go in
`lib/countries.js` (the forms render them automatically) and are mapped to
facts in `factsFor()` in `lib/complianceDb.js`.
