export const LEAD_STATUSES = [
  "new",
  "contacted",
  "test_drive",
  "negotiation",
  "order_placed",
  "delivered",
  "lost",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Pipeline stages in funnel order (lost is a terminal exit, not a stage). */
export const FUNNEL_STAGES: LeadStatus[] = [
  "new",
  "contacted",
  "test_drive",
  "negotiation",
  "order_placed",
  "delivered",
];
export const OPEN_STATUSES: LeadStatus[] = ["new", "contacted", "test_drive", "negotiation"];

export const REP_ROLES = ["branch_manager", "sales_officer"] as const;
export type RepRole = (typeof REP_ROLES)[number];

export interface Metadata {
  generated_at?: string;
  description?: string;
  date_range?: string;
  notes?: string;
}

export interface Branch {
  id: string;
  name: string;
  city: string;
}

export interface SalesRep {
  id: string;
  name: string;
  branch_id: string;
  role: RepRole;
  joined: string;
}

export interface StatusEvent {
  status: LeadStatus;
  timestamp: string;
  note?: string;
}

export interface Lead {
  id: string;
  customer_name: string;
  phone: string;
  source: string;
  model_interested: string;
  status: LeadStatus;
  assigned_to: string;
  branch_id: string;
  created_at: string;
  last_activity_at: string;
  status_history: StatusEvent[];
  expected_close_date: string | null;
  deal_value: number;
  lost_reason: string | null;
}

export interface Target {
  branch_id: string;
  month: string; // YYYY-MM
  target_units: number;
  target_revenue: number;
}

export interface Delivery {
  lead_id: string;
  order_date: string;
  delivery_date: string;
  days_to_deliver: number;
  delay_reason: string | null;
}

export interface DealershipData {
  metadata?: Metadata;
  branches: Branch[];
  sales_reps: SalesRep[];
  leads: Lead[];
  targets: Target[];
  deliveries: Delivery[];
}
