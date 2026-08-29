// cspell:ignore bkash
import { success } from "zod";
import config from "../../config";
import { getBkashIdToken } from "../../lib/bkash";
import { prisma } from "../../lib/prisma";
import {
  AppointmentStatus,
  PaymentStatus,
  ScheduleStatus,
} from "../../../generated/prisma/enums";
import type { RequestUser } from "../../middleware/checkAuth";
import httpStatus from "http-status";
import { AppError } from "../../utils/AppError";
import { IBookAppointmentPayload } from "./appointment.interface";
import { addMinutes, isAfter, isBefore, isSameDay } from "date-fns";
import { transporter } from "../../lib/nodemailer";
import path from "path";
import ejs from "ejs";
import PDFDocument from "pdfkit";

const bookAppointmentIntoDb = async (
  payload: IBookAppointmentPayload,
  user: RequestUser,
) => {
  const transactionResult = await prisma.$transaction(async (tx) => {
    // business logic

    const patient = await prisma.patient.findUnique({
      where: { userId: user.userId },
    });

    if (!patient) {
      throw new AppError(httpStatus.NOT_FOUND, "Patient profile not found");
    }

    const schedule = await prisma.schedule.findUnique({
      where: { id: payload.scheduleId },
      include: { doctor: true },
    });

    if (!schedule || schedule.isDeleted) {
      throw new AppError(httpStatus.NOT_FOUND, "Schedule not found");
    }

    if (schedule.status !== ScheduleStatus.PUBLISHED) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "This Schedule is not published yet",
      );
    }

    const now = new Date();
    if (!isSameDay(now, schedule.startDateTime)) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "This schedule is not available today",
      );
    }

    if (!isBefore(now, schedule.startDateTime)) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "This schedule has already Started",
      );
    }
    if (isAfter(now, schedule.startDateTime)) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "This schedule has already Started",
      );
    }

    const existingAppointment = await prisma.appointment.findFirst({
      where: {
        patientId: patient.id,
        scheduleId: schedule.id,
        // status: { not: AppointmentStatus.CANCELLED },
      },
    });

    if (existingAppointment?.status === AppointmentStatus.PENDING) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "You already have a pending appointment. Please complete payment to continue",
      );
    }
    if (existingAppointment?.status === AppointmentStatus.ONGOING) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "You already have a Ongoing appointment.",
      );
    }
    if (existingAppointment?.status === AppointmentStatus.COMPLETED) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Your appointment for this schedule already completed",
      );
    }
    if (existingAppointment?.status === AppointmentStatus.CONFIRMED) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "You already have a confirmed appointment ",
      );
    }

    if (schedule.availableSlots === 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "This schedule is fully booked",
      );
    }

    if (!schedule.doctor.consultationFee) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Doctor has not set a consultation fee yet",
      );
    }

    const amount = schedule.doctor.consultationFee.toString();

    const appointment = await tx.appointment.create({
      data: {
        status: AppointmentStatus.PENDING,
        patientId: patient.id,
        doctorId: schedule.doctor.id,
        scheduleId: schedule.id,
      },
    });

    const bkashIdToken = await getBkashIdToken();

    if (!bkashIdToken) {
      throw new AppError(httpStatus.BAD_GATEWAY, "Bkash id token not found");
    }

    const bkashCreatePaymentResponse = await fetch(
      `${config.bkash_base_url}/tokenized/checkout/create`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: bkashIdToken,
          "X-APP-Key": config.bkash_app_key,
        },
        body: JSON.stringify({
          // agreementID: "TokenizedMerchant01L3IKB6H1565072174986", // Appointment id
          mode: "0011",
          // payerReference: "01770618575", // User email or phone number
          payerReference: user.email, // User email or phone number
          callbackURL: `${config.bkash_callback_url}/appointment/book-appointment/payment/callback`,
          // merchantAssociationInfo: "MI05MID54RF09123456One",
          amount: amount,
          currency: "BDT",
          intent: "sale",
          // merchantInvoiceNumber: "Inv", //appointment id
          merchantInvoiceNumber: appointment.id,
        }),
      },
    );

    const bkashCreatePaymentResult = await bkashCreatePaymentResponse.json();

    await tx.payment.create({
      data: {
        merchantInvoiceNumber: bkashCreatePaymentResult.merchantInvoiceNumber,
        appointmentId: appointment.id,
        amount: amount,
        gatewayResponse: bkashCreatePaymentResult,
        bkashPaymentId: bkashCreatePaymentResult.paymentID,
        payerReference: user.email,
      },
    });
    console.log({ bkashCreatePaymentResult });
    return {
      paymentUrl: bkashCreatePaymentResult.bkashURL,
    };
  });

  return transactionResult;
};

const payAppointmentIntoDb = async (payload: any, user: RequestUser) => {
  const appointmentId = payload.appointmentId;

  const existingAppointment = await prisma.appointment.findUnique({
    where: {
      id: appointmentId,
    },
    include: {
      schedule: {
        include: {
          doctor: true,
        },
      },
    },
  });

  if (!existingAppointment) {
    throw new AppError(httpStatus.NOT_FOUND, "Appointment does not exists");
  }

  if (existingAppointment.status !== "PENDING") {
    throw new AppError(httpStatus.CONFLICT, "Appointment is not pending");
  }

  // if (
  //   existingAppointment.status === "CANCELLED" ||
  //   existingAppointment.status === "ONGOING" ||
  //   existingAppointment.status === "COMPLETED"
  // ) {
  //   const appointmentStatus = existingAppointment.status.toLowerCase();
  //   throw new Error(`Appointment is already ${appointmentStatus}`);
  // }

  if (!existingAppointment.schedule.doctor.consultationFee) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Doctor has not set a consultation fee yet",
    );
  }

  const amount =
    existingAppointment.schedule.doctor.consultationFee?.toString();
  const bkashIdToken = await getBkashIdToken();

  if (!bkashIdToken) {
    throw new AppError(httpStatus.BAD_GATEWAY, "Bkash id token not found");
  }

  const bkashCreatePaymentResponse = await fetch(
    `${config.bkash_base_url}/tokenized/checkout/create`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: bkashIdToken,
        "X-APP-Key": config.bkash_app_key,
      },
      body: JSON.stringify({
        // agreementID: "TokenizedMerchant01L3IKB6H1565072174986", // Appointment id
        mode: "0011",
        // payerReference: "01770618575", // User email or phone number
        payerReference: user.email, // User email or phone number
        callbackURL: `${config.bkash_callback_url}/appointment/book-appointment/payment/callback`,
        // merchantAssociationInfo: "MI05MID54RF09123456One",
        amount: amount,
        currency: "BDT",
        intent: "sale",
        // merchantInvoiceNumber: "Inv", //appointment id
        merchantInvoiceNumber: existingAppointment.id,
      }),
    },
  );

  const bkashCreatePaymentResult = await bkashCreatePaymentResponse.json();

  await prisma.payment.update({
    where: {
      appointmentId: existingAppointment.id,
    },
    data: {
      merchantInvoiceNumber: bkashCreatePaymentResult.merchantInvoiceNumber,
      gatewayResponse: bkashCreatePaymentResult,
      bkashPaymentId: bkashCreatePaymentResult.paymentID,
    },
  });
  return {
    paymentUrl: bkashCreatePaymentResult.bkashURL,
  };
};

const bookAppointmentCallback = async (query: Record<string, any>) => {
  const transactionResult = await prisma.$transaction(
    async (tx) => {
      const paymentId = query.paymentID;

      if (!paymentId) {
        throw new AppError(httpStatus.BAD_REQUEST, "Payment Id missing");
      }

      const status = query.status;

      if (!status) {
        throw new AppError(httpStatus.BAD_REQUEST, "Payment status is missing");
      }

      const bkashIdToken = await getBkashIdToken();

      if (!bkashIdToken) {
        throw new AppError(
          httpStatus.BAD_GATEWAY,
          "Bkash access token not found",
        );
      }

      const executedPaymentResponse = await fetch(
        `${config.bkash_base_url}/tokenized/checkout/execute`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: bkashIdToken,
            "X-APP-Key": config.bkash_app_key,
          },
          body: JSON.stringify({
            paymentID: paymentId,
          }),
        },
      );

      const executedPaymentResult = await executedPaymentResponse.json();

      if (status === "success") {
        const appointment = await prisma.appointment.findUnique({
          where: {
            id: executedPaymentResult.merchantInvoiceNumber,
          },
          include: {
            schedule: true,
            patient: true,
            doctor: true,
          },
        });

        if (!appointment) {
          throw new AppError(httpStatus.NOT_FOUND, "Appointment Found");
        }

        //total slot = 3, available slot = 3
        // (total-available) + 1
        const alreadyBookedSlots =
          appointment.schedule.totalSlots - appointment.schedule.availableSlots;
        const serialNumber = alreadyBookedSlots + 1;
        // 25 August => 3:00 PM - 4:00 PM
        //1st person Joining time => startDateTime = 2026-08-25T15:00:00.148Z => 25 August 3:00 PM
        // serial number (1) - 1 * 20 => 0 minutes

        //2nd person Joining time => startDateTime = 2026-08-25T15:20:00.148Z => 25 August 3:20 PM
        // serial number (2) - 1 * 20 => 20 minutes

        //3rd person Joining time => startDateTime = 2026-08-25T15:40:00.148Z => 25 August 3:40 PM
        // serial number (3) - 1 * 20 => 40 minutes

        const joiningTime = addMinutes(
          appointment.schedule.startDateTime,
          (serialNumber - 1) * 20,
        );

        await tx.appointment.update({
          where: {
            id: executedPaymentResult.merchantInvoiceNumber,
          },
          data: {
            status: AppointmentStatus.CONFIRMED,
            joiningTime,
            serialNumber,
          },
        });

        const newAvailableSlots = appointment.schedule.availableSlots - 1;

        await tx.schedule.update({
          where: {
            id: appointment.schedule.id,
          },
          data: {
            availableSlots: newAvailableSlots,
          },
        });

        await tx.payment.update({
          where: {
            appointmentId: executedPaymentResult.merchantInvoiceNumber,
            bkashPaymentId: paymentId,
          },
          data: {
            status: PaymentStatus.PAID,
            bkashTrxId: executedPaymentResult.trxID,
            paidAt: executedPaymentResult.paymentExecuteTime,
            gatewayResponse: executedPaymentResult,
          },
        });

        const pdfDocument = new PDFDocument({
          margin: 50,
        });

        const pdfChunks: Buffer[] = [];

        pdfDocument.on("data", (chunk: Buffer) => {
          pdfChunks.push(chunk);
        });

        const pdfReadyPromise = new Promise<Buffer>((resolve) => {
          pdfDocument.on("end", () => {
            resolve(Buffer.concat(pdfChunks));
          });
        });

        pdfDocument
          .fontSize(20)
          .text("CareNest Healthcare System", { align: "center" });
        pdfDocument
          .fontSize(14)
          .text("Appointment Invoice", { align: "center" });
        pdfDocument.moveDown(2);

        pdfDocument
          .fontSize(12)
          .text(`Patient Name:${appointment.patient.name}`);
        pdfDocument.text(`Patient Email: ${appointment.patient.email}`);
        pdfDocument.moveDown();

        pdfDocument.text(`Doctor Name:${appointment.doctor.name}`);
        pdfDocument.text(
          `Specialization: ${appointment.doctor.specialization}`,
        );
        pdfDocument.moveDown();

        pdfDocument.text(
          `Appointment Date: ${appointment.schedule.startDateTime.toDateString()}`,
        );
        pdfDocument.text(`Your Joining Time:${joiningTime.toString()}`);
        pdfDocument.text(`Your Serial Number: ${serialNumber}`);
        pdfDocument.text(`Meeting Link:${appointment.schedule.meetingLink}`);
        pdfDocument.moveDown();

        pdfDocument.text(`Amount Paid: ${executedPaymentResult.amount} BDT`);
        pdfDocument.text(`Payment Method: bkash`);
        pdfDocument.text(`Transaction Id: ${executedPaymentResult.trxID}`);
        pdfDocument.text(
          `Paid At: ${executedPaymentResult.paymentExecuteTime}`,
        );

        pdfDocument.end();

        const pdfBuffer = await pdfReadyPromise;

        const templatePath = path.join(
          process.cwd(),
          "src/app/templates/registration-user-otp.ejs",
        );
        const templateData = {
          name: name,
        };
        const html = await ejs.renderFile(templatePath, templateData);

        await transporter.sendMail({
          from: config.email_sender,
          to: appointment.patient.email,
          subject: "Your Appointment Invoice - CareNest Healthcare System",
          html,
          attachments: [
            {
              filename: "invoice.pdf",
              content: pdfBuffer,
            },
          ],
        });

        return {
          redirectUrl: `${config.frontend_url}/dashboard/my-appointments?status=success`,
        };
      } else if (status === "failure") {
        await tx.payment.update({
          where: {
            bkashPaymentId: paymentId,
          },
          data: {
            status: PaymentStatus.FAILED,
            gatewayResponse: executedPaymentResult,
          },
        });
        return {
          redirectUrl: `${config.frontend_url}/dashboard/my-appointments?status=failure`,
        };
      } else if (status === "cancel") {
        await tx.payment.update({
          where: {
            bkashPaymentId: paymentId,
          },
          data: {
            status: PaymentStatus.CANCELLED,
            gatewayResponse: executedPaymentResult,
          },
        });
        return {
          executedPaymentResult,
          redirectUrl: `${config.frontend_url}/dashboard/my-appointments?status=cancel`,
        };
      } else {
        return {
          executedPaymentResult,
          redirectUrl: `${config.frontend_url}/dashboard/my-appointments?error=payment-failed`,
        };
      }
    },
    {
      maxWait: 10_000, // wait up to 10 seconds for a DB connection
      timeout: 30_000, // allow the transaction to run for 30 seconds
    },
  );
  return transactionResult;
};

const cancelAppointment = async (payload: any) => {
  const transactionResult = await prisma.$transaction(async (tx) => {
    const appointmentId = payload.appointmentId;

    const existingAppointment = await tx.appointment.findUnique({
      where: {
        id: appointmentId,
      },
      include: {
        payment: true,
      },
    });

    if (!existingAppointment) {
      throw new AppError(httpStatus.NOT_FOUND, "Appointment does not exists");
    }

    if (
      existingAppointment.status === "ONGOING" ||
      existingAppointment.status === "COMPLETED"
    ) {
      throw new AppError(
        httpStatus.CONFLICT,
        "Appointment already Ongoing or Completed",
      );
    }

    if (existingAppointment.status === "CANCELLED") {
      throw new AppError(httpStatus.CONFLICT, "Appointment already Cancelled");
    }

    const updatedAppointment = await tx.appointment.update({
      where: {
        id: existingAppointment.id,
      },
      data: {
        status: "CANCELLED",
      },
    });

    const bkashIdToken = await getBkashIdToken();

    if (!bkashIdToken) {
      throw new AppError(httpStatus.BAD_GATEWAY, "Bkash id token not found");
    }

    const bkashRefundPaymentResponse = await fetch(
      `${config.bkash_base_url}/v2/tokenized-checkout/refund/payment/transaction`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: bkashIdToken,
          "X-APP-Key": config.bkash_app_key,
        },
        body: JSON.stringify({
          paymentID: existingAppointment.payment?.bkashPaymentId,
          trxID: existingAppointment.payment?.bkashTrxId,
          amount: existingAppointment.payment?.amount.toString(),
          sku: "Appointment Cancellation",
          reason: "patient canceled the appointment",
        }),
      },
    );

    const bkashRefundPaymentResult = await bkashRefundPaymentResponse.json();
    console.log(bkashRefundPaymentResult);

    const updatedPayment = await tx.payment.update({
      where: {
        appointmentId: existingAppointment.id,
      },
      data: {
        refundTrxId: bkashRefundPaymentResult.refundTrxID,
        refundedAt: bkashRefundPaymentResult.completedTime,
        refundAmount: bkashRefundPaymentResult.amount,
        refundReason: "Appointment Cancellation",
        status: PaymentStatus.REFUNDED,
        gatewayResponse: bkashRefundPaymentResult,
      },
    });
    return {
      appointment: updatedAppointment,
      payment: updatedPayment,
    };
  });
  return transactionResult;
};

export const AppointmentService = {
  bookAppointmentIntoDb,
  bookAppointmentCallback,
  payAppointmentIntoDb,
  cancelAppointment,
};
