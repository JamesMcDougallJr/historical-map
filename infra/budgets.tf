# The spend backstop for semantic search (plans/23-search-semantic.md): the
# app's per-IP limit and daily ceiling bound normal use; this catches anything
# they don't. Skipped when alert_email is empty.

resource "aws_budgets_budget" "bedrock" {
  count = var.alert_email != "" ? 1 : 0

  name         = "${var.project_name}-bedrock"
  budget_type  = "COST"
  limit_amount = tostring(var.bedrock_monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "Service"
    values = ["Amazon Bedrock"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
