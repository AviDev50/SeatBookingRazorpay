import "dotenv/config";
import Razorpay from "razorpay";
import crypto from "crypto";
 import { db } from "../db.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

export const getBookingPage = async (req, res) => {
  try {
    const bookingId = req.params.bookingId;
    
    // here we getting booking details
    const [bookings] = await db.query(
      `SELECT * FROM bookings WHERE booking_id = ?`,
      [bookingId]
    );
    
    if (bookings.length === 0) {
      return res.status(404).send("Booking not found");
    }
    
    const booking = bookings[0];
    
    // here we checking if booking is still valid
    if (booking.status !== 'PENDING') {
      return res.send(`Booking is ${booking.status}. Cannot process payment.`);
    }
    
    // here we getting seats for this booking
    const [seatRows] = await db.query(
      `SELECT s.seat_number, s.seat_id FROM booking_seats bs 
       JOIN seats s ON bs.seat_id = s.seat_id 
       WHERE bs.booking_id = ?`,
      [bookingId]
    );
    
    const seats = seatRows.map(row => ({
      seat_id: row.seat_id,
      seat_number: row.seat_number
    }));
    
    // here we render the booking page with the existing order_id
    res.render("booking", {
      bookingId: booking.booking_id,
      amount: booking.amount,
      user_id: booking.user_id,
      show_id: booking.show_id,
      seats: seats,
      razorpayKey: process.env.RAZORPAY_KEY_ID,
      orderId: booking.razorpay_order_id  
    });
  } catch (error) {
    console.error("Error loading booking:", error);
    res.status(500).send("Error loading booking page");
  }
};
export const createBooking = async (req, res) => {
  let connection;

  try {
    const {user_id,show_id,seats,amount} = req.body;

    connection = await db.getConnection();
    await connection.beginTransaction();

    //here we set limit to 5 seats
  if (seats.length > 5) {
  return res.status(400).json({
    message: "You don't have option to select more than 5 seats"
  });
}

    const seatIds = seats.map(seat => seat.seat_id);

    // here we checking are empty or not
    const [availableSeats] = await connection.query(
      `SELECT seat_id FROM seats WHERE seat_id IN (?) AND is_booked = 0`,
      [seatIds]
    );

    //here we checking if selected seats are not that seats which are avilable then we stop here and give back"
    if (availableSeats.length !== seatIds.length) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: "Some seats are already booked" });
    }

    // here we book seats with setting 1 
    await connection.query(`UPDATE seats SET is_booked = 1 WHERE seat_id IN (?)`, [seatIds]);

    // Update show availability
    await connection.query(
      `UPDATE shows SET available_seats = available_seats - ? WHERE show_id = ?`,
      [seatIds.length, show_id]
    );

    // here we set expiry time using Date method in 15 min
    const expiresAt = new Date(Date.now() + 1 * 60 * 1000);

    // Here we insert booking in booking table
    const [booking] = await connection.query(
      `INSERT INTO bookings (user_id,show_id,amount,expires_at)
       VALUES (?, ?, ?, ?)`,
      [user_id, show_id,amount, expiresAt]
    );

    const bookingId = booking.insertId;

    //here we insert in booking seat table 
    for (let seatId of seatIds) {
      await connection.query(
        `INSERT INTO booking_seats (booking_id, seat_id) VALUES (?, ?)`,
        [bookingId, seatId]
      );
    }

    await connection.commit();
const totalAmount = amount || seatIds.length * 1;

const order = await razorpay.orders.create({
  amount: totalAmount * 100, 
  currency: "INR",
  receipt: String(bookingId)
});

await connection.query(
  `UPDATE bookings SET razorpay_order_id=? WHERE booking_id=?`,
  [order.id, bookingId]
);

return res.json({
  success: true,
  bookingId,
  order_id: order.id,
  amount: totalAmount,
  key: process.env.RAZORPAY_KEY_ID
});


  } catch (error) {
    if (connection) await connection.rollback();
    console.log(error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    if (connection) connection.release();
  }
};
export const paymentSuccess = async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature, booking_id } = req.body;

    //here we verify razorpay signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    // here verify signature only when we use real frontend
    // if (expectedSignature !== razorpay_signature) {
    //   return res.status(400).json({w
    //     success: false,
    //     message: "Payment verification failed"
    //   });
    // }

    // here we  Save payment details to send id and signature   
await db.query(
  `UPDATE bookings 
   SET status='CONFIRMED',
       razorpay_payment_id=?,
       razorpay_signature=?
   WHERE booking_id=?`,
  [razorpay_payment_id, razorpay_signature, booking_id]
);

    //here we storing in db confirmed
    await db.query(
      "UPDATE bookings SET status='CONFIRMED' WHERE booking_id=? AND expires_at > NOW()",
      [booking_id]
    );

    return res.json({
      success: true,
      message: "Payment successful & booking confirmed!",
      booking_id
    });

  } catch (error) {
    console.log(error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const paymentFail = async (req, res) => {
  const { booking_id } = req.body;

  const connection = await db.getConnection();
  await connection.beginTransaction();

  //here we find booked seats
  const [rows] = await connection.query(
    `SELECT seat_id FROM booking_seats WHERE booking_id=?`,
    [booking_id]
  );

  if (rows.length > 0) {
    const seatIds = rows.map(r => r.seat_id);

    // here we release seats
    await connection.query(`UPDATE seats SET is_booked = 0 WHERE seat_id IN (?)`, [seatIds]);

    // here we increase available seats
    await connection.query(
      `UPDATE shows SET available_seats = available_seats + ? WHERE show_id = 1`,
      [seatIds.length]
    );
  }

  // here we mark booking as failed
  await connection.query(`UPDATE bookings SET status='FAILED' WHERE booking_id=?`, [booking_id]);

  await connection.commit();

  return res.json({
    success: true,
    message: "Payment failed. Seats released.",
    booking_id
  });
};



