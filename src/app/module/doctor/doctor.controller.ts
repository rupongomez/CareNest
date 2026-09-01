import type { Request, Response } from "express";
import { catchAsync } from "../../utils/catchAsync";
import { sendResponse } from "../../utils/sendResponse";
import httpStatus from "http-status";
import { DoctorService } from "./doctor.service";
import { applyAsDoctorValidationZodSchema } from "./doctor.validation";
import { AppError } from "../../utils/AppError";

const applyAsDoctor = catchAsync(async (req: Request, res: Response) => {
  const files = req.files as { [fieldname: string]: Express.Multer.File[] };
  const resume = files?.["resume"] ? files["resume"][0] : null;
  const additionalFiles = files?.["additionalFiles"] || [];

  const zodValidationResult = applyAsDoctorValidationZodSchema.safeParse(
    JSON.parse(req.body.data),
  );
  if (!zodValidationResult.success) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Validation failed: " +
        JSON.stringify(zodValidationResult.error.format()),
    );
  }

  const payload = zodValidationResult.data;

  const result = await DoctorService.applyAsDoctor(
    payload,
    resume,
    additionalFiles,
  );
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Image uploaded Successfully.",
    data: result,
  });
});
const verifyDoctorEmail = catchAsync(async (req: Request, res: Response) => {
  const payload = req.body;

  const result = await DoctorService.verifyDoctorEmail(payload);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Doctor email verified Successfully.",
    data: result,
  });
});
const approveDoctor = catchAsync(async (req: Request, res: Response) => {
  const payload = req.body;
  const user = req.user!;

  const result = await DoctorService.approveDoctor(payload, user);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Doctor application approved Successfully.",
    data: result,
  });
});
const getAllDoctors = catchAsync(async (req: Request, res: Response) => {
  const { data, meta } = await DoctorService.getAllDoctors(req.query);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Doctors retrieved Successfully.",
    data: data,
    meta: meta,
  });
});

const updateDoctorProfile = catchAsync(async (req: Request, res: Response) => {
  const payload = req.body;
  const user = req.user!;

  const result = await DoctorService.updateDoctorProfile(payload, user);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Doctor Profile Updated Successfully",
    data: result,
  });
});

const getAvailableDoctorByTodaysSchedule = catchAsync(
  async (req: Request, res: Response) => {
    const { data, meta } =
      await DoctorService.getAvailableDoctorByTodaysSchedule(req.query);
    sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Today's Available Doctors Retrieved Successfully",
      data,
      meta,
    });
  },
);

const getAllDoctorsListPublic = catchAsync(
  async (req: Request, res: Response) => {
    const { data, meta } = await DoctorService.getAllDoctorsListPublic(
      req.query,
    );
    sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Doctors Retrieved Successfully",
      data,
      meta,
    });
  },
);

const getSingleDoctorPublicProfile = catchAsync(
  async (req: Request, res: Response) => {
    const doctorId = req.params.doctorId as string;

    const result = await DoctorService.getSingleDoctorPublicProfile(doctorId);
    sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Doctor Profile Retrieved Successful",
      data: result,
    });
  },
);
export const DoctorController = {
  applyAsDoctor,
  verifyDoctorEmail,
  approveDoctor,
  getAllDoctors,
  updateDoctorProfile,
  getAvailableDoctorByTodaysSchedule,
  getAllDoctorsListPublic,
  getSingleDoctorPublicProfile,
};
