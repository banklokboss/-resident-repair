import express from "express";
import cors from "cors";
import { requireAuth } from "./lib/admin";
import * as adminHandlers from "./handlers/admin";
import * as lineHandlers from "./handlers/line";
import * as repairsHandlers from "./handlers/repairs";
import * as scheduledHandlers from "./handlers/scheduled";

const app = express();

app.use(cors({ origin: true }));
app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf; // For LINE signature verification
  }
}));

// Admin Routes
app.post("/api/createStaff", requireAuth(["admin"]), adminHandlers.createStaff);
app.post("/api/updateStaff", requireAuth(["admin"]), adminHandlers.updateStaff);
app.post("/api/getDashboardStats", requireAuth(["admin"]), adminHandlers.getDashboardStats);

// Rating Routes (Public)
app.post("/api/getRatingInfo", adminHandlers.getRatingInfo);
app.post("/api/submitRating", adminHandlers.submitRating);

// LINE Webhook
app.post("/lineWebhook", lineHandlers.lineWebhook);

// LINE Auth / Binding
app.post("/api/exchangeResidentLink", lineHandlers.exchangeResidentLink);
app.post("/api/generateBindingCode", requireAuth(["admin", "technician"]), lineHandlers.generateBindingCode);
app.post("/api/unbindLine", requireAuth(["admin", "technician", "resident"]), lineHandlers.unbindLine);
app.post("/api/sendTestNotification", requireAuth(["admin", "technician", "resident"]), lineHandlers.sendTestNotification);

// Repairs Routes
app.post("/api/createRepairStaff", requireAuth(["admin", "technician"]), repairsHandlers.createRepairStaff);
app.post("/api/createRepairResident", requireAuth(["resident"]), repairsHandlers.createRepairResident);
app.post("/api/scheduleRepair", requireAuth(["admin", "technician"]), repairsHandlers.scheduleRepair);
app.post("/api/uploadCompletionImages", requireAuth(["admin", "technician"]), repairsHandlers.uploadCompletionImages);
app.post("/api/completeRepair", requireAuth(["admin", "technician"]), repairsHandlers.completeRepair);
app.post("/api/cancelRepair", requireAuth(["admin", "technician"]), repairsHandlers.cancelRepair);

// Notification Cron (Could be triggered securely via Render cron or simple setInterval)
app.post("/api/retryNotifications", scheduledHandlers.retryNotificationsApi);

// Start Server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
