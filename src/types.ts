// =============================================================================
// YNAB API Types
// =============================================================================

export interface YNABAccount {
  id: string;
  name: string;
  type: string;
  on_budget: boolean;
  closed: boolean;
  balance: number;
  cleared_balance: number;
  uncleared_balance: number;
}

export interface YNABCategory {
  id: string;
  category_group_id: string;
  category_group_name?: string;
  name: string;
  hidden: boolean;
  budgeted: number;
  activity: number;
  balance: number;
  goal_type: string | null;
  goal_target: number | null;
  goal_percentage_complete: number | null;
  goal_needs_whole_amount: boolean | null;
  goal_day: number | null;
  goal_cadence: number | null;
  goal_cadence_frequency: number | null;
  goal_creation_month: string | null;
  goal_target_month: string | null;
  goal_months_to_budget: number | null;
  goal_under_funded: number | null;
  goal_overall_funded: number | null;
  goal_overall_left: number | null;
}

export interface YNABCategoryGroup {
  id: string;
  name: string;
  hidden: boolean;
  categories: YNABCategory[];
}

export interface YNABPayee {
  id: string;
  name: string;
  transfer_account_id: string | null;
}

export interface YNABTransaction {
  id: string;
  date: string;
  amount: number;
  memo: string | null;
  cleared: string;
  approved: boolean;
  account_id: string;
  account_name: string;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
  subtransactions: YNABSubTransaction[];
}

export interface YNABSubTransaction {
  id: string;
  amount: number;
  memo: string | null;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
}

export interface YNABScheduledTransaction {
  id: string;
  date_first: string;
  date_next: string;
  frequency: string;
  amount: number;
  memo: string | null;
  account_id: string;
  account_name: string;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
}

export interface YNABBudget {
  id: string;
  name: string;
}

export interface YNABMonth {
  month: string;
  income: number;
  budgeted: number;
  activity: number;
  to_be_budgeted: number;
  age_of_money: number | null;
}
