# litera-partners

A NetSuite SuiteCloud (SDF) account customization project for Litera. It contains two scripts:

- **SCG | UE | Partner Discount**: adds partner discount lines to Sales Orders, one per class.
- **SCG | MR | Amortization Entry Update**: copies memo, segment and project values onto amortization journal entry lines.

## Project layout

```text
src/
  FileCabinet/SuiteScripts/
    scg-ue-partner-discount.js     User Event: partner discount lines
    scg_update_amort_entries.js    Map/Reduce: amortization JE update
  Objects/
    customscript_scg_ue_partner_discount.xml
    custcol_partner_discount_percent.xml
    custbody_scg_generated_partner_line.xml
    customscript_scg_mr_amort.xml
    customsearch_scg_amort_update_ss_3.xml
  manifest.xml
  deploy.xml
```

## Setup and deployment

You need the [SuiteCloud CLI for Node.js](https://www.npmjs.com/package/@oracle/suitecloud-cli) and an authenticated account. The project's default auth ID is `4770034_SB1-Adm-Sand` (sandbox), set in `project.json`.

```bash
npm install                           # installs Prettier
suitecloud account:setup              # only if the auth ID isn't already set up
suitecloud project:validate --server
suitecloud project:deploy
```

`deploy.xml` deploys everything under `FileCabinet/` and `Objects/`.

## Partner Discount (User Event)

| | |
|---|---|
| Script | `customscript_scg_ue_partner_discount` |
| Deployment | `customdeploy_scg_ue_partner_discount` |
| Record | Sales Order |
| Entry point | `afterSubmit` (create and edit) |

### What it does

When a Sales Order is created or edited, the script:

1. Finds every item line that has a **Partner Discount Percent** (`custcol_partner_discount_percent`).
2. Works out each line's discount as `amount × percent / 100`.
3. Groups the discounted lines by the standard line **Class** field and sums the discount for each class.
4. Reloads the Sales Order and adds one partner item line per class:

   | Field | Value |
   |---|---|
   | Item | Internal ID `6443` (`PARTNER_ITEM_ID`) |
   | Quantity | 1 |
   | Rate | Negative of the class total, rounded to 2 decimals |
   | Class | The class of the source lines |
   | Rev Start Date | Earliest `custcol_rev_start_date` in the class |
   | Rev End Date | Latest `custcol_rev_end_date` in the class |
   | Ready to Invoice | Checked (`custcol_ready_to_inv`) |
   | Billing Schedule | Looked up by the SO billing frequency (see below) |

5. Checks **Generated Partner Line** (`custbody_scg_generated_partner_line`) and saves the Sales Order.

### Rules and edge cases

- **Runs once per Sales Order.** If Generated Partner Line is already checked, the script exits. Later edits don't add, change or remove partner lines. The flag also stops the script's own save from triggering it again.
- **Every discounted line needs a class.** If any discounted line has no class, the script logs an error (`afterSubmit: missing class`) with the SO ID and line numbers, and adds no partner lines to that Sales Order.
- **Classes that total $0** after rounding get no partner line.
- **No billing schedule match.** If no record matches the SO billing frequency, the script adds no lines.
- **Empty rev dates.** An empty start or end date on a discounted line is treated as 1970-01-01, which makes that class's date range wrong. Make sure discounted lines have both dates.
- **Errors are logged, not thrown.** A failure doesn't block the user's save, so check the script's execution log if partner lines are missing.

### Billing schedule lookup

The script searches `customrecord_scg_disc_billing_schedule_t` for the first record where `custrecord_scg_dbs_billing_frequency` matches the Sales Order's `custbody_so_billing_frequency`. It then uses that record's `custrecord_scg_dbs_billing_schedule` on every partner line.

### Dependencies

These are included in this project:

- `custcol_partner_discount_percent`: transaction line field, Percent, shown on sales transactions
- `custbody_scg_generated_partner_line`: transaction body field, Checkbox

These must already exist in the target account. They're not in this project:

- Item internal ID `6443`, the partner discount item. The ID is hardcoded and can differ between sandbox and production.
- `custbody_so_billing_frequency`
- `custcol_rev_start_date`, `custcol_rev_end_date`, `custcol_ready_to_inv`
- Custom record `customrecord_scg_disc_billing_schedule_t`, with fields `custrecord_scg_dbs_billing_frequency` and `custrecord_scg_dbs_billing_schedule`
- The Classes feature, turned on with class set on the line level

> **Note:** In `customscript_scg_ue_partner_discount.xml` the script record is set to inactive (`<isinactive>T</isinactive>`), but the deployment is released. Set the script to active before you expect it to run.

## Amortization Entry Update (Map/Reduce)

| | |
|---|---|
| Script | `customscript_scg_mr_amort` |
| Parameter | `custscript_scg_update_je_ss`: the saved search to process |
| Saved search | `customsearch_scg_amort_update_ss_3`, set on deployment `customdeploy2` |

For each journal entry line the saved search returns, the script copies these values from the applied-to (source) transaction line:

- **Memo**, unless the line's memo is `Amortization Source`
- **Segment `cseg3`**
- **Project** (`custcol_scg_project`)

It then saves each journal entry once, after all its lines are updated. Deployments are `NOTSCHEDULED`, so run them on demand.
