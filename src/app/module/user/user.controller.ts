import type { Request, Response } from "express";
import { catchAsync } from "../../utils/catchAsync";
import { sendResponse } from "../../utils/sendResponse";
import httpStatus from "http-status";
import { userServices } from "./user.service";
import { AppError } from "../../utils/AppError";

const uploadProfileImage = catchAsync(async (req: Request, res: Response) => {
  console.log(req.file?.buffer, "from req.file");
  if (!req.file) {
    throw new AppError(httpStatus.NOT_FOUND, "No file found");
  }
  const userId = req.user?.userId;
  const result = await userServices.uploadProfileImageIntoDb(
    req.file?.buffer,
    userId!,
  );
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Image uploaded Successfully.",
    data: result,
  });
});
export const userController = {
  uploadProfileImage,
};
