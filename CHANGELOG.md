# Changelog

## 0.4.1

- Published from GitHub Actions with a provenance statement. The nodes are the same as in 0.4.0.

## 0.4.0

- Citypicked Trigger: Profile Check Point Open (API 1.7). It starts the workflow for each point the profile check
  newly finds to improve, with the same fields as the instant trigger plus the ID of the opening and when the point
  opened. A point that opens again after it was done starts it again.

## 0.3.0

- Citypicked Trigger, New Google Review: asks for the reviews that reached Citypicked since the last check (API 1.6),
  so a review Google hands over days late still starts the workflow. Each review also has the reviewer name, whether
  it is answered, the link to answer it in Citypicked and when it reached Citypicked, the same fields as the instant
  trigger. The older reviews a newly connected Google profile brings do not start it.

## 0.2.0

- Citypicked Instant Trigger: starts the workflow right away through a webhook, for New Private Feedback, Request
  Rated, New 5-Star Click, New Google Review and Profile Check Point Open.
- Citypicked Trigger: New Google Review.
- Profile Check Point Open is in the instant trigger only.

## 0.1.0

- Citypicked node: Request (Send, Get, Get Many), Feedback (Get Many), Location (Get Many, Get Review Link), Stats (Get).
- Citypicked Trigger: New Private Feedback, Request Rated, New 5-Star Click.
- Citypicked API credential with API key and base URL.
