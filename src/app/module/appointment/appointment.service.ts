// cspell:ignore bkash
import { success } from "zod";
import config from "../../config";
import { getBkashIdToken } from "../../lib/bkash";
import { prisma } from "../../lib/prisma";
import {
  AppointmentStatus,
  PaymentStatus,
  Role,
  ScheduleStatus,
} from "../../../generated/prisma/enums";
import type { RequestUser } from "../../middleware/checkAuth";
import httpStatus from "http-status";
import { AppError } from "../../utils/AppError";
import {
  IBookAppointmentPayload,
  ICancelAppointmentPayload,
  IPayAppointmentPayload,
  IUpdateAppointmentStatusPayload,
} from "./appointment.interface";
import { addMinutes, isAfter, isBefore, isSameDay, subHours } from "date-fns";
import { transporter } from "../../lib/nodemailer";
import path from "path";
import ejs from "ejs";
import PDFDocument from "pdfkit";
import { IQuery } from "../../interfaces";
import { AppointmentWhereInput } from "../../../generated/prisma/models";

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

const payAppointmentIntoDb = async (
  payload: IPayAppointmentPayload,
  user: RequestUser,
) => {
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
          .font("Helvetica-Bold")
          .fontSize(24)
          .fillColor("#0f766e")
          .text("CareNest", { align: "center" });

        pdfDocument
          .font("Helvetica")
          .fontSize(10)
          .fillColor("#6b7280")
          .text("Online Medical Management System", { align: "center" });

        pdfDocument.moveDown(0.8);

        pdfDocument
          .moveTo(50, pdfDocument.y)
          .lineTo(545, pdfDocument.y)
          .strokeColor("#e5e7eb")
          .lineWidth(1)
          .stroke();

        pdfDocument.moveDown(1.2);

        // Invoice title
        pdfDocument
          .font("Helvetica-Bold")
          .fontSize(20)
          .fillColor("#111827")
          .text("Appointment Invoice", { align: "center" });

        pdfDocument
          .font("Helvetica")
          .fontSize(10)
          .fillColor("#6b7280")
          .text("Payment confirmation and appointment details", {
            align: "center",
          });

        pdfDocument.moveDown(2);

        // Patient & Doctor Section
        const sectionStartY = pdfDocument.y;

        pdfDocument
          .font("Helvetica-Bold")
          .fontSize(12)
          .fillColor("#0f766e")
          .text("PATIENT INFORMATION", 50, sectionStartY);

        pdfDocument
          .font("Helvetica")
          .fontSize(10)
          .fillColor("#374151")
          .text(`Name: ${appointment.patient.name}`, 50, sectionStartY + 22)
          .text(`Email: ${appointment.patient.email}`, 50, sectionStartY + 39);

        pdfDocument
          .font("Helvetica-Bold")
          .fontSize(12)
          .fillColor("#0f766e")
          .text("DOCTOR INFORMATION", 310, sectionStartY);

        pdfDocument
          .font("Helvetica")
          .fontSize(10)
          .fillColor("#374151")
          .text(`Name: ${appointment.doctor.name}`, 310, sectionStartY + 22)
          .text(
            `Specialization: ${appointment.doctor.specialization}`,
            310,
            sectionStartY + 39,
          );

        pdfDocument.y = sectionStartY + 75;

        // Divider
        pdfDocument
          .moveTo(50, pdfDocument.y)
          .lineTo(545, pdfDocument.y)
          .strokeColor("#e5e7eb")
          .lineWidth(1)
          .stroke();

        pdfDocument.moveDown(1.3);

        // Appointment Details
        pdfDocument
          .font("Helvetica-Bold")
          .fontSize(12)
          .fillColor("#0f766e")
          .text("APPOINTMENT DETAILS");

        pdfDocument.moveDown(0.7);

        const appointmentDetailsY = pdfDocument.y;

        pdfDocument
          .font("Helvetica")
          .fontSize(10)
          .fillColor("#374151")
          .text(
            `Appointment Date: ${appointment.schedule.startDateTime.toDateString()}`,
            50,
            appointmentDetailsY,
          )
          .text(
            `Joining Time: ${joiningTime.toLocaleString()}`,
            50,
            appointmentDetailsY + 20,
          )
          .text(`Serial Number: ${serialNumber}`, 50, appointmentDetailsY + 40);

        pdfDocument.text(
          `Meeting Link: ${appointment.schedule.meetingLink}`,
          310,
          appointmentDetailsY,
        );

        pdfDocument.y = appointmentDetailsY + 75;

        // Payment Summary Box
        const paymentBoxY = pdfDocument.y;

        pdfDocument
          .roundedRect(50, paymentBoxY, 495, 125, 8)
          .fillColor("#f0fdfa")
          .fill();

        pdfDocument
          .roundedRect(50, paymentBoxY, 495, 125, 8)
          .strokeColor("#99f6e4")
          .lineWidth(1)
          .stroke();

        pdfDocument
          .font("Helvetica-Bold")
          .fontSize(12)
          .fillColor("#115e59")
          .text("PAYMENT SUMMARY", 70, paymentBoxY + 18);

        pdfDocument
          .font("Helvetica")
          .fontSize(10)
          .fillColor("#374151")
          .text(`Payment Method: bKash`, 70, paymentBoxY + 45)
          .text(
            `Transaction ID: ${executedPaymentResult.trxID}`,
            70,
            paymentBoxY + 63,
          )
          .text(
            `Paid At: ${executedPaymentResult.paymentExecuteTime}`,
            70,
            paymentBoxY + 81,
          );

        pdfDocument
          .font("Helvetica-Bold")
          .fontSize(15)
          .fillColor("#0f766e")
          .text(
            `Amount Paid: ${executedPaymentResult.amount} BDT`,
            320,
            paymentBoxY + 52,
            {
              width: 205,
              align: "right",
            },
          );

        pdfDocument.y = paymentBoxY + 155;

        // Payment Status
        pdfDocument
          .font("Helvetica-Bold")
          .fontSize(11)
          .fillColor("#059669")
          .text("✓ PAYMENT SUCCESSFUL", {
            align: "center",
          });

        pdfDocument.moveDown(1);

        // Footer divider
        pdfDocument
          .moveTo(50, pdfDocument.y)
          .lineTo(545, pdfDocument.y)
          .strokeColor("#e5e7eb")
          .lineWidth(1)
          .stroke();

        pdfDocument.moveDown(1);

        // Footer
        pdfDocument
          .font("Helvetica")
          .fontSize(9)
          .fillColor("#6b7280")
          .text("Thank you for choosing CareNest.", {
            align: "center",
          });

        pdfDocument
          .fontSize(8)
          .fillColor("#9ca3af")
          .text(
            "This is an automatically generated invoice. Please keep it for your records.",
            {
              align: "center",
            },
          );

        pdfDocument.end();

        const pdfBuffer = await pdfReadyPromise;

        const templatePath = path.join(
          process.cwd(),
          "src/app/templates/booking-confirmed.ejs",
        );
        const templateData = {
          name: appointment.patient.name,
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

const cancelAppointment = async (
  payload: ICancelAppointmentPayload,
  user: RequestUser,
) => {
  const transactionResult = await prisma.$transaction(async (tx) => {
    const appointmentId = payload.appointmentId;

    const existingAppointment = await tx.appointment.findUnique({
      where: {
        id: appointmentId,
        patient: {
          email: user.email,
        },
      },
      include: {
        payment: true,
        schedule: true,
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
        status: AppointmentStatus.CANCELLED,
      },
    });

    await prisma.schedule.update({
      where: {
        id: existingAppointment.schedule.id,
      },
      data: {
        availableSlots: { increment: 1 },
      },
    });

    // Refund process
    const now = new Date();

    const startDateTime = existingAppointment.schedule.startDateTime; // 25 august : 3:00 PM

    // After 2:00 PM no refund
    // Must cancel before 2:00 PM
    const refundCutOffTime = subHours(startDateTime, 1);

    // now > refundCutOff Time => no refund
    // now < refundCutOff Time => refund eligible
    const isEligibleForRefund = isBefore(now, refundCutOffTime);

    if (isEligibleForRefund) {
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

      await tx.payment.update({
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
    }

    const newPaymentInfo = await prisma.payment.findUnique({
      where: {
        appointmentId: existingAppointment.id,
      },
    });
    return {
      appointment: updatedAppointment,
      payment: newPaymentInfo,
    };
  });
  return transactionResult;
};

// Doctor only CONFIRMED => ONGOING => COMPLETED
const updateAppointmentStatus = async (
  appointmentId: string,
  payload: IUpdateAppointmentStatusPayload,
  user: RequestUser,
) => {
  const doctor = await prisma.doctor.findUnique({
    where: { userId: user.userId },
  });

  if (!doctor) {
    throw new AppError(httpStatus.NOT_FOUND, "Doctor Profile not found");
  }

  const appointment = await prisma.appointment.findUnique({
    where: {
      id: appointmentId,
      doctorId: doctor.id,
    },
  });

  if (!appointment) {
    throw new AppError(httpStatus.NOT_FOUND, "Appointment Not found");
  }

  if (appointment.status === AppointmentStatus.COMPLETED) {
    throw new AppError(httpStatus.FORBIDDEN, "Appointment Already Completed");
  }

  if (appointment.status === AppointmentStatus.CANCELLED) {
    throw new AppError(httpStatus.FORBIDDEN, "Appointment already cancelled");
  }

  if (appointment.status === AppointmentStatus.PENDING) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "Appointment pending. You can change the status after appointment is confirmed",
    );
  }

  if (appointment.status === AppointmentStatus.CONFIRMED) {
    if (payload.status !== "ONGOING") {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Confirmed appointment must be ongoing at first",
      );
    }

    await prisma.appointment.update({
      where: {
        id: appointment.id,
      },
      data: {
        status: AppointmentStatus.ONGOING,
      },
    });
  }

  if (appointment.status === AppointmentStatus.ONGOING) {
    if (payload.status !== "COMPLETED") {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Ongoing Appointment status can only be changed to completed",
      );
    }
    await prisma.appointment.update({
      where: {
        id: appointment.id,
      },
      data: {
        status: AppointmentStatus.COMPLETED,
      },
    });
  }

  const updatedAppointment = await prisma.appointment.findUnique({
    where: {
      id: appointment.id,
    },
  });

  return updatedAppointment;
};

// Patient Appointments
const getMyAppointments = async (query: IQuery, user: RequestUser) => {
  const limit = query.limit ? Number(query.limit) : 10;
  const page = query.page ? Number(query.page) : 1;
  const skip = (page - 1) * limit;
  const sortBy = query.sortBy ? query.sortBy : "createdAt";
  const sortOrder = query.sortOrder ? query.sortOrder : "desc";

  const patient = await prisma.patient.findUnique({
    where: { userId: user.userId },
  });

  if (!patient) {
    throw new AppError(httpStatus.NOT_FOUND, "Patient profile not found ");
  }

  const andConditions: AppointmentWhereInput[] = [
    {
      patientId: patient.id,
    },
  ];

  if (query.status) {
    andConditions.push({ status: query.status });
  }

  const appointments = await prisma.appointment.findMany({
    where: { AND: andConditions },
    take: limit,
    skip,
    orderBy: { [sortBy]: sortOrder },
    include: {
      doctor: { select: { id: true, name: true, specialization: true } },
      schedule: true,
      payment: true,
    },
  });

  const total = await prisma.appointment.count({
    where: { AND: andConditions },
  });

  return {
    data: appointments,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

// Doctor Appointments
const getDoctorAppointments = async (query: IQuery, user: RequestUser) => {
  const limit = query.limit ? Number(query.limit) : 10;
  const page = query.page ? Number(query.page) : 1;
  const skip = (page - 1) * limit;
  const sortBy = query.sortBy ? query.sortBy : "createdAt";
  const sortOrder = query.sortOrder ? query.sortOrder : "desc";

  const doctor = await prisma.doctor.findUnique({
    where: { userId: user.userId },
  });

  if (!doctor) {
    throw new AppError(httpStatus.NOT_FOUND, "Doctor profile not found");
  }

  const andConditions: AppointmentWhereInput[] = [
    {
      doctorId: doctor.id,
    },
  ];

  if (query.status) {
    andConditions.push({ status: query.status });
  }

  const appointments = await prisma.appointment.findMany({
    where: { AND: andConditions },
    take: limit,
    skip,
    orderBy: { [sortBy]: sortOrder },
    include: {
      doctor: { select: { id: true, name: true, specialization: true } },
      schedule: true,
      payment: true,
    },
  });

  const total = await prisma.appointment.count({
    where: { AND: andConditions },
  });

  return {
    data: appointments,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

// Admin super admin
const getAllAppointments = async (query: IQuery, user: RequestUser) => {
  const limit = query.limit ? Number(query.limit) : 10;
  const page = query.page ? Number(query.page) : 1;
  const skip = (page - 1) * limit;
  const sortBy = query.sortBy ? query.sortBy : "createdAt";
  const sortOrder = query.sortOrder ? query.sortOrder : "desc";
  const andConditions: AppointmentWhereInput[] = [];

  if (query.status) {
    andConditions.push({ status: query.status });
  }
  if (query.doctorId) {
    andConditions.push({ doctorId: query.doctorId });
  }
  if (query.patientId) {
    andConditions.push({ patientId: query.patientId });
  }

  if (query.doctorEmail) {
    andConditions.push({
      doctor: {
        email: query.doctorEmail,
      },
    });
  }
  if (query.patientEmail) {
    andConditions.push({
      patient: {
        email: query.patientEmail,
      },
    });
  }

  const appointments = await prisma.appointment.findMany({
    where: { AND: andConditions },
    take: limit,
    skip,
    orderBy: { [sortBy]: sortOrder },
    include: {
      doctor: { select: { id: true, name: true, specialization: true } },
      schedule: true,
      payment: true,
    },
  });

  const total = await prisma.appointment.count({
    where: { AND: andConditions },
  });

  return {
    data: appointments,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

// for all logged in users
const getSingleAppointments = async (
  appointmentId: string,
  user: RequestUser,
) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      patient: { select: { id: true, name: true, email: true, userId: true } },
      doctor: {
        select: { id: true, name: true, specialization: true, userId: true },
      },
      schedule: true,
      payment: true,
    },
  });

  if (!appointment) {
    throw new AppError(httpStatus.NOT_FOUND, "Appointment not found");
  }

  if (user.role === Role.PATIENT) {
    if (appointment.patient.userId !== user.userId) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        "You are not allowed to view this appointment",
      );
    }
  }
  if (user.role === Role.DOCTOR) {
    if (appointment.doctor.userId !== user.userId) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        "You are not allowed to view this appointment",
      );
    }
  }

  return appointment;
};

export const AppointmentService = {
  bookAppointmentIntoDb,
  bookAppointmentCallback,
  payAppointmentIntoDb,
  cancelAppointment,
  updateAppointmentStatus,
  getMyAppointments,
  getDoctorAppointments,
  getAllAppointments,
  getSingleAppointments,
};
