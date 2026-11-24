import { DealershipData } from "./types";

/** Minimal valid example of the expected structure; offered as a download on the upload screen. */
export const TEMPLATE: DealershipData = {
  metadata: {
    generated_at: "2025-12-31T00:00:00Z",
    description: "Dealership sales data",
    date_range: "June 2025 - December 2025",
    notes: "Optional free text",
  },
  branches: [{ id: "B1", name: "Downtown Toyota", city: "Chennai" }],
  sales_reps: [
    { id: "SR1", name: "Kavitha Sharma", branch_id: "B1", role: "branch_manager", joined: "2023-10-09" },
    { id: "SR2", name: "Arjun Rao", branch_id: "B1", role: "sales_officer", joined: "2024-02-01" },
  ],
  leads: [
    {
      id: "L0001",
      customer_name: "Hema Rajan",
      phone: "9000000000",
      source: "website",
      model_interested: "Innova Hycross",
      status: "contacted",
      assigned_to: "SR2",
      branch_id: "B1",
      created_at: "2025-06-01T18:46:00Z",
      last_activity_at: "2025-06-03T10:00:00Z",
      status_history: [
        { status: "new", timestamp: "2025-06-01T18:46:00Z", note: "Website enquiry" },
        { status: "contacted", timestamp: "2025-06-03T10:00:00Z", note: "Called, interested" },
      ],
      expected_close_date: "2025-07-12",
      deal_value: 2040000,
      lost_reason: null,
    },
  ],
  targets: [{ branch_id: "B1", month: "2025-06", target_units: 39, target_revenue: 86649651 }],
  deliveries: [],
};
