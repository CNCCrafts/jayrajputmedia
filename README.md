# jayrajputmedia

## Wallet deposits

Customers can top up with Cashfree or by scanning the BharatPe QR code (`public/images/bharatpe-qr.png`, UPI ID `6375063791@ybl`). BharatPe QR deposits require a UTR and remain pending until an administrator verifies the payment and approves the wallet credit. A UTR submission alone does not confirm payment.

## Automatic order status updates

Orders sent to an upstream provider are checked automatically every 60 seconds. The provider must support the standard SMM-panel `action=status&id=<provider-order-id>` request and return a status such as `Pending`, `In progress`, `Completed`, `Partial`, `Canceled`, or `Failed`. The interval can be changed with `DWR_INTERVAL_MS`; setting `ENABLE_DWR=false` disables scheduled checks. API clients requesting an order's `status` also trigger an immediate provider check for that order.

API-created orders use the same provider forwarding and status synchronization as website orders. Explicit provider rejections are marked `Failed`, while network errors are left pending because the provider may have accepted the order without the response reaching this server.

### Webhook for external API fulfillment

For API orders fulfilled by an external system that cannot be polled, configure a strong random `ORDER_STATUS_WEBHOOK_SECRET` in the server environment and restart/redeploy the app. The fulfillment system can then report terminal status:

```http
POST /api/webhooks/order-status
Authorization: Bearer <ORDER_STATUS_WEBHOOK_SECRET>
Content-Type: application/json

{"order_id": 123, "status": "Completed"}
```

Use `"Failed"` when fulfillment fails. The order ID is the local ID returned by this site's reseller API `add` action. Requests without the secret are rejected; only `Completed` and `Failed` are accepted. Repeating the same terminal update is safe, while changing an already-terminal status returns `409`. This endpoint does not mark orders completed by a timer—the fulfillment system must send the real outcome.

## Homepage content

Administrators can edit the homepage's Latest News (one item per line) and the disclaimer displayed below Quick Order in the Admin Portal under **Home Page Content**.
