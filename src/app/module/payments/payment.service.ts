import { IQuery } from "../../interfaces";
import { prisma } from "../../lib/prisma";
import { RequestUser } from "../../middleware/checkAuth";
import httpStatus from "http-status";
import { AppError } from "../../utils/AppError";

const getMyPayments = async (query: IQuery, user: RequestUser) => {
  const patient = await prisma.patient.findUnique({
    where: { userId: user.userId },
  });

  if (!patient) {
    throw new AppError(httpStatus.NOT_FOUND, "Patient profile not found");
  }
};

const getAllPayments = async () => {};

const getSinglePayment = async () => {};

export const PaymentServices = {
  getMyPayments,
  getAllPayments,
  getSinglePayment,
};
