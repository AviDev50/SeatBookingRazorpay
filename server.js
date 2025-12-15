import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import bookingRoutes from "./routes/routes.js";
import { db } from "./db.js";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); 

app.set("view engine", "ejs");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

app.use("/", bookingRoutes);

// here is cron job to expire bookings, here we storing all pending booking from db in expired array
cron.schedule("* * * * *", async () => {
  const [expired] = await db.query(
    `SELECT booking_id,show_id FROM bookings WHERE status='PENDING' AND expires_at < NOW()`
  );

  for (let b of expired) { // here we running loop through each booking
    const id = b.booking_id;
       
    //here we checking selected seats 
    const [rows] = await db.query(
      `SELECT seat_id FROM booking_seats WHERE booking_id=?`,
      [id]
    );

    if (rows.length) {
      const seatIds = rows.map(r => r.seat_id);
      
    //   //here we updated seats status 
    //   await db.query(`UPDATE seats SET is_booked=0 WHERE seat_id IN (?)`, [seatIds]);
       await db.query(
      `UPDATE seats SET is_booked=0 WHERE seat_id IN (${seatIds.join(",")})`
    );

      await db.query(
        `UPDATE shows SET available_seats = available_seats + ? WHERE show_id = ?`,
        [seatIds.length,b.show_id]
      );
    }

    await db.query(
      `UPDATE bookings SET status='EXPIRED' WHERE booking_id=?`,
      [id]
    );
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Cron job scheduled to run every minute`);
});

