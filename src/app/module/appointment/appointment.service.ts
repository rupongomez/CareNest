// cspell:ignore bkash
import { success } from "zod";
import config from "../../config";
import { getBkashIdToken } from "../../lib/bkash";
import { prisma } from "../../lib/prisma";
import {
  AppointmentStatus,
  PaymentStatus,
} from "../../../generated/prisma/enums";
import type { RequestUser } from "../../middleware/checkAuth";
import httpStatus from "http-status";
import { AppError } from "../../utils/AppError";

const bookAppointmentIntoDb = async (payload: any, user: RequestUser) => {
  const transactionResult = await prisma.$transaction(async (tx) => {
    // business logic

    const appointment = await tx.appointment.create({
      data: {
        status: AppointmentStatus.PENDING,
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
          amount: "1200",
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
        amount: "1200",
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
        amount: "1200",
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
        await tx.appointment.update({
          where: {
            id: executedPaymentResult.merchantInvoiceNumber,
          },
          data: {
            status: AppointmentStatus.CONFIRMED,
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
