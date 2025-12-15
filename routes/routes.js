import express from "express";
import {
  createBooking,
  paymentSuccess,
  paymentFail,
  getBookingPage 
} from "../controllers/bookingController.js";

const router = express.Router();

router.get("/booking/:bookingId", getBookingPage);
router.post("/book", createBooking);
router.post("/payment/success", paymentSuccess);
router.post("/payment/fail", paymentFail);

export default router;