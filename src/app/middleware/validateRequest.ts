import type { NextFunction, Request, Response } from "express";
import { catchAsync } from "../utils/catchAsync";
import type z from "zod";
import httpStatus from "http-status";
import { AppError } from "../utils/AppError";

export const validateRequest = (zodSchema: z.ZodObject) => {
  return catchAsync((req: Request, res: Response, next: NextFunction) => {
    const payload = req.body ?? {};
    const result = zodSchema.safeParse(payload);

    if (!result.success) {
      console.log(result.error);
      console.log(result.error.issues);
      throw new AppError(
        httpStatus.BAD_REQUEST,
        result.error.issues[0].message,
      );
    }

    req.body = result.data;

    next();
  });
};
