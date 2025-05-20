/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
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

      const totalAmount = partnerLines.reduce((acc, cur) => {
        const val = cur.discountAmount;
        return acc + val;
      }, 0);

      log.debug({
        title: "total amount",
        details: totalAmount,
      });
      const roundedAmount = Math.round(totalAmount * 100) / 100;
      log.debug({
        title: "roundedAmount",
        details: roundedAmount,
      });
      const startDates = partnerLines.map((x) => x.startDate);

      const minStartDate = new Date(Math.min(...startDates));

      const endDates = partnerLines.map((x) => x.endDate);

      const maxDate = new Date(Math.max(...endDates));

      log.debug({
        title: `start: ${minStartDate}`,
        details: `end: ${maxDate}`,
      });

      if (roundedAmount === 0) return;

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
        value: roundedAmount * -1,
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
        value: maxDate,
        ignoreFieldChange: false,
      });
      soRec.setCurrentSublistValue({
        sublistId: "item",
        fieldId: "custcol_rev_start_date",
        value: minStartDate,
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
