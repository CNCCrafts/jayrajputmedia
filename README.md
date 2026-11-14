# jayrajputmedia

## Wallet deposits

Customers can top up with Cashfree or by scanning the PhonePe QR code (`public/images/bharatpe-qr.png`, UPI ID `6375063791@ybl`). PhonePe QR deposits require a UTR and remain pending until an administrator verifies the payment and approves the wallet credit. Submitting the UTR opens WhatsApp with a prefilled confirmation message; the deposit is not credited until it is verified.

## Automatic order status updates

Orders sent to an upstream provider are checked automatically every 60 seconds. Status checks use a form-encoded `POST` with `action=status` and `order=<provider-order-id>`, as documented by Smminsta, and expect a status such as `Pending`, `In progress`, `Completed`, `Partial`, `Canceled`, or `Failed`. The interval can be changed with `DWR_INTERVAL_MS`; setting `ENABLE_DWR=false` disables scheduled provider checks. API clients requesting an order's `status` also trigger an immediate provider check for that order.

As a separate fallback, unresolved orders are automatically marked `Completed` 30 minutes after placement when the quantity is below 50,000, or 4 hours after placement when it is 50,000 or more. This runs independently of provider polling and checks once per minute, including after a server restart. It does not confirm that the provider delivered the order, so the resulting status is time-based rather than a verified fulfillment result. Failed, canceled, and other terminal statuses are left unchanged.

API-created orders use the same provider forwarding and status synchronization as website orders. Explicit provider rejections are marked `Failed`, while network errors are left pending because the provider may have accepted the order without the response reaching this server.

### Webhook for external API fulfillment

For API orders fulfilled by an external system that cannot be polled, configure a strong random `ORDER_STATUS_WEBHOOK_SECRET` in the server environment and restart/redeploy the app. The fulfillment system can then report terminal status:

```http
POST /api/webhooks/order-status
Authorization: Bearer <ORDER_STATUS_WEBHOOK_SECRET>
Content-Type: application/json

{"order_id": 123, "status": "Completed"}
```

Use `"Failed"` when fulfillment fails. The order ID is the local ID returned by this site's reseller API `add` action. Requests without the secret are rejected; only `Completed` and `Failed` are accepted. Repeating the same terminal update is safe, while changing an already-terminal status returns `409`. The timer fallback is independent of this webhook.

## Homepage content

Administrators can edit the homepage's Latest News (one item per line), upload a visitor-only homepage banner, and update the disclaimer displayed below Quick Order in the Admin Portal under **Home Page Content**. Signed-in users see Latest News in that area; visitors see the uploaded banner when one is configured.

## Provider services

Provider services can be edited from **Admin Portal → Services**. Admin edits are retained when provider services are imported or synced again; provider cost updates continue to sync.

## Password recovery

Password reset links are sent by email and expire after one hour. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and optionally `SMTP_FROM` in the deployment environment. Do not commit SMTP credentials. If SMTP is not configured, users are directed to contact support.
