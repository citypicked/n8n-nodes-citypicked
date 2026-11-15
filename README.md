# n8n-nodes-citypicked

Citypicked nodes for [n8n](https://n8n.io). Citypicked gets local businesses more reviews: send a review request
whenever a booking, order or appointment happens in another tool, and act on what comes back, including new reviews
on your Google Business Profile.

- [Installation](#installation)
- [Credentials](#credentials)
- [Operations](#operations)
- [Triggers](#triggers)
- [Compatibility](#compatibility)

## Installation

In n8n, open **Settings > Community Nodes**, choose **Install** and enter `n8n-nodes-citypicked`.
See the [n8n guide to community nodes](https://docs.n8n.io/integrations/community-nodes/installation/).

## Credentials

1. In Citypicked, open **Settings > API** and make a key. It is shown once.
2. To send review requests from n8n, give the key the "send" permission. A key without it can only read.
3. In n8n, add a **Citypicked API** credential and paste the key. Leave **Base URL** as it is
   (`https://api.citypicked.com/v1`).

The key acts as the team member who made it, with that member's locations.

## Operations

**Citypicked** node:

| Resource | Operation | What it does |
| --- | --- | --- |
| Request | Send | Sends a review request to one customer by email, SMS or WhatsApp. |
| Request | Get | Gets one review request. |
| Request | Get Many | Lists review requests, newest first, filtered by location, status or time. |
| Feedback | Get Many | Lists private feedback from your review page, newest first. |
| Location | Get Many | Lists your locations with their review links. |
| Location | Get Review Link | Gets a location's review link, and its QR code as a PNG or SVG file if you want it. |
| Stats | Get | Gets requests sent, clicks, ratings, average rating, public clicks and feedback for a date range. |

**Send** needs the customer's agreement: set **Customer Agreed to Get This Message** only when the customer agreed
to hear from you, for example when they booked. SMS to US and Canadian numbers also needs the **Consent Method**.
Map the booking or order ID into **Booking or Order ID** so a repeated run within 24 hours does not send twice.

A request that comes back as a duplicate (asked within the last 30 days) or opted out finishes normally with that
outcome. A contact that is not valid, no credits left or a missing consent method stop the item with the reason.

## Triggers

**Citypicked Instant Trigger** starts the workflow right away. Citypicked calls your n8n, so n8n must be reachable
on a public https address. It has these events:

- **New Private Feedback**: a customer left private feedback on your review page.
- **Request Rated**: a customer gave a star rating.
- **New 5-Star Click**: a happy customer clicked through to a public review site, such as Google.
- **New Google Review**: Citypicked found a new review on your Google profile.
- **Profile Check Point Open**: the profile check found something to improve on your Google profile, such as too
  few photos.

**Citypicked Trigger** checks Citypicked on the schedule you set and has the same five events.

Each event can be limited to one location. After you activate the workflow, only new items start it. The instant and
the scheduled New Google Review give the same fields: the reviewer name, whether it is answered and a link to answer
it in Citypicked. The scheduled one also says when the review reached Citypicked, and has your answer and whether you
can answer it through Citypicked. Google sometimes hands a review over days after it was written; the scheduled
trigger still starts the workflow for it. When you connect a Google profile, its older reviews do not start it.

The scheduled Profile Check Point Open gives the same fields as the instant one, plus the ID of the opening and when
the point opened. A point you fixed that opens again later starts the workflow again. A point that opens and is fixed
between two checks does not start it.

## Compatibility

Built with the n8n node CLI (`@n8n/node-cli`) against `n8n-workflow` 2.x. Needs no other packages.
