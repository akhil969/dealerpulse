/** Plain-language definitions shown next to each number. */
export const HINT = {
  orders: "Cars customers ordered in the selected months, compared with the target set for the same months.",
  revenue: "The total price of the cars ordered in the selected months.",
  leads: "New customer enquiries that came in during the selected months: walk-ins, calls, website, social media and so on.",
  conversion: "Out of the enquiries that came in during these months, the share that went on to order a car.",
  deliveries: "Cars handed over to customers in these months, and the average wait between order and handover.",
  pipeline: "Customers still being worked on right now (new, contacted, test drive or negotiating) and what their deals are worth.",
  firstContact: "Average time between an enquiry coming in and the first call or message back.",
  followUp: "Customers nobody has contacted for 7 days or more, plus cars ordered over 30 days ago that still haven't been delivered.",
  quiet: "Customers still in progress with no contact for 7 days or more. The longer the gap, the more likely they buy elsewhere.",
  rank: "Where this person stands in their branch by number of cars ordered.",
} as const;
