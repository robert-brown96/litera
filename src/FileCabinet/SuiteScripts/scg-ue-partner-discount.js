/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * SCG | UE | Partner Discount
 *
 * Adds partner discount lines to a Sales Order after create/edit. Item lines
 * with a partner discount percent (custcol_partner_discount_percent) are
 * grouped by the standard line "class" field, and one negative-rate partner
 * item line (PARTNER_ITEM_ID) is added per class:
 *   - Rate: -(sum of amount * percent / 100 for the class), rounded to 2 decimals
 *   - Class: the class of the source lines
 *   - Rev start/end date: earliest start / latest end date of the class's lines
 *   - Billing schedule: looked up from customrecord_scg_disc_billing_schedule_t
 *     by the SO billing frequency (custbody_so_billing_frequency)
 *
 * Classes that total $0 get no line. If any discounted line has no class, an
 * error is logged and no partner lines are created for the Sales Order.
 * Lines are generated once: custbody_scg_generated_partner_line is set on save,
 * and the script exits on later edits.
 */
define(["N/record", "N/search"], (record, search) => {
  const PARTNER_DISCOUNT_FIELD = "custcol_partner_discount_percent";
  const CHECK_GEN_LINE = "custbody_scg_generated_partner_line";
  const PARTNER_ITEM_ID = 6443;

  /**
   * Defines the function definition that is executed before record is submitted.
   * @param {Object} context
   * @param {Record} context.newRecord - New record
   * @param {Record} context.oldRecord - Old record
   * @param {string} context.type - Trigger type; use values from the context.UserEventType enum
   * @since 2015.2
   */
  const beforeSubmit = (context) => {};

  /**
   * Defines the function definition that is executed after record is submitted.
   * Creates one partner discount line per class on the Sales Order (see file header).
   * @param {Object} context
   * @param {Record} context.newRecord - New record
   * @param {Record} context.oldRecord - Old record
   * @param {string} context.type - Trigger type; use values from the context.UserEventType enum
   * @since 2015.2
   */
  const afterSubmit = (context) => {
    try {
      log.debug({
        title: "type",
        details: context.type,
      });
      if (context.type !== "edit" && context.type !== "create") return;

      const genLine = context.newRecord.getValue({
        fieldId: CHECK_GEN_LINE,
      });

      if (genLine) return;

      const itemCount = context.newRecord.getLineCount({
        sublistId: "item",
      });

      const billingFreq = context.newRecord.getValue({
        fieldId: "custbody_so_billing_frequency",
      });

      const partnerLines = [];

      for (let i = 0; i < itemCount; i++) {
        const partnerPercent = context.newRecord.getSublistValue({
          sublistId: "item",
          line: i,
          fieldId: PARTNER_DISCOUNT_FIELD,
        });

        if (!partnerPercent) continue;

        const classId = context.newRecord.getSublistValue({
          sublistId: "item",
          line: i,
          fieldId: "class",
        });

        const startDate = context.newRecord.getSublistValue({
          sublistId: "item",
          line: i,
          fieldId: "custcol_rev_start_date",
        });

        const endDate = context.newRecord.getSublistValue({
          sublistId: "item",
          line: i,
          fieldId: "custcol_rev_end_date",
        });

        const amount = context.newRecord.getSublistValue({
          sublistId: "item",
          line: i,
          fieldId: "amount",
        });

        const discountAmount = amount * (partnerPercent / 100);

        partnerLines.push({
          line: i + 1,
          classId,
          partnerPercent,
          startDate,
          endDate,
          amount,
          discountAmount,
        });
      }

      log.debug({
        title: "lines",
        details: partnerLines,
      });

      if (partnerLines.length === 0) return;

      // Every discounted line must have a class; otherwise skip the whole SO
      const missingClass = partnerLines.filter((x) => !x.classId);
      if (missingClass.length > 0) {
        log.error({
          title: "afterSubmit: missing class",
          details: `Sales Order ${context.newRecord.id} has partner discount lines with no class (lines: ${missingClass
            .map((x) => x.line)
            .join(", ")}). No partner lines created.`,
        });
        return;
      }

      // Sum discount amounts and find the date range per class
      const classGroups = partnerLines.reduce((acc, cur) => {
        const group = acc[cur.classId] || {
          classId: cur.classId,
          totalAmount: 0,
          startDates: [],
          endDates: [],
        };
        group.totalAmount += cur.discountAmount;
        group.startDates.push(cur.startDate);
        group.endDates.push(cur.endDate);
        acc[cur.classId] = group;
        return acc;
      }, {});

      const partnerClassLines = Object.values(classGroups)
        .map((group) => ({
          classId: group.classId,
          roundedAmount: Math.round(group.totalAmount * 100) / 100,
          minStartDate: new Date(Math.min(...group.startDates)),
          maxDate: new Date(Math.max(...group.endDates)),
        }))
        .filter((x) => x.roundedAmount !== 0);

      log.debug({
        title: "partner class lines",
        details: partnerClassLines,
      });

      if (partnerClassLines.length === 0) return;

      const billingSchedSearch = search.create({
        type: "customrecord_scg_disc_billing_schedule_t",
        filters: [
          ["custrecord_scg_dbs_billing_frequency", "anyof", billingFreq],
        ],
        columns: [
          search.createColumn({
            name: "custrecord_scg_dbs_billing_schedule",
          }),
        ],
      });

      const searchRes = billingSchedSearch.run().getRange({ start: 0, end: 1 });
      if (searchRes.length === 0) return;

      const bs = searchRes[0].getValue({
        name: "custrecord_scg_dbs_billing_schedule",
      });
      log.debug({
        title: "billingSched",
        details: bs,
      });
      const soId = context.newRecord.id;

      const soRec = record.load({
        type: record.Type.SALES_ORDER,
        id: soId,
        isDynamic: true,
      });

      partnerClassLines.forEach((partnerLine) => {
        soRec.selectNewLine({
          sublistId: "item",
        });

        soRec.setCurrentSublistValue({
          sublistId: "item",
          fieldId: "item",
          value: PARTNER_ITEM_ID,
          ignoreFieldChange: false,
        });

        soRec.setCurrentSublistValue({
          sublistId: "item",
          fieldId: "quantity",
          value: "1",
          ignoreFieldChange: false,
        });

        soRec.setCurrentSublistValue({
          sublistId: "item",
          fieldId: "rate",
          value: partnerLine.roundedAmount * -1,
          ignoreFieldChange: false,
        });

        soRec.setCurrentSublistValue({
          sublistId: "item",
          fieldId: "class",
          value: partnerLine.classId,
          ignoreFieldChange: false,
        });

        soRec.setCurrentSublistValue({
          sublistId: "item",
          fieldId: "custcol_ready_to_inv",
          value: true,
          ignoreFieldChange: false,
        });

        soRec.setCurrentSublistValue({
          sublistId: "item",
          fieldId: "custcol_rev_end_date",
          value: partnerLine.maxDate,
          ignoreFieldChange: false,
        });
        soRec.setCurrentSublistValue({
          sublistId: "item",
          fieldId: "custcol_rev_start_date",
          value: partnerLine.minStartDate,
          ignoreFieldChange: false,
        });
        soRec.setCurrentSublistValue({
          sublistId: "item",
          fieldId: "billingschedule",
          value: bs,
          ignoreFieldChange: false,
        });
        soRec.commitLine({
          sublistId: "item",
        });
      });

      soRec.setValue({
        fieldId: CHECK_GEN_LINE,
        value: true,
      });

      //Save the Sales Order
      const soRecordId = soRec.save({
        enableSourcing: true,
        ignoreMandatoryFields: true,
      });
      log.debug("soRecordId", soRecordId);
    } catch (e) {
      log.error({
        title: "afterSubmit: ERROR",
        details: e,
      });
    }
  };

  return { afterSubmit };
});
