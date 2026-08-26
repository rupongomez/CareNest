import { UploadApiResponse } from "cloudinary";
import { prisma } from "../../lib/prisma";
import { cloudinaryUpload } from "../../lib/cloudinary";
import bcrypt from "bcryptjs";
import {
  DoctorVerificationStatus,
  Role,
} from "../../../generated/prisma/enums";
import crypto from "crypto";
import { redisClient } from "../../lib/redis";
import path from "path";
import { transporter } from "../../lib/nodemailer";
import config from "../../config";
import ejs from "ejs";
import {
  IApplyAsDoctorPayload,
  IApproveDoctorPayload,
  IVerifyDoctorEmailPayload,
} from "./doctor.interface";
import { error } from "console";
import { RequestUser } from "../../middleware/checkAuth";

const applyAsDoctor = async (
  payload: IApplyAsDoctorPayload,
  resume: Express.Multer.File | null,
  additionalFiles: Express.Multer.File[],
) => {
  const isUserExist = await prisma.user.findUnique({
    where: {
      email: payload.user.email,
    },
  });

  if (isUserExist) {
    throw new Error("User with this email already exists");
  }

  const resumeUploadResult = await new Promise<UploadApiResponse>(
    (resolve, reject) => {
      cloudinaryUpload.uploader
        .upload_stream(
          {
            resource_type: "auto",
          },
          async (error, result) => {
            if (error) {
              return reject(error);
            }
            if (!result) {
              return reject(new Error("Something went wrong!"));
            }
            resolve(result);
            // return result;
          },
        )
        .end(resume?.buffer);
    },
  );

  const additionalFilesUploadResults = await Promise.all(
    additionalFiles.map((file) => {
      return new Promise<UploadApiResponse>((resolve, reject) => {
        cloudinaryUpload.uploader
          .upload_stream(
            {
              resource_type: "auto",
            },
            async (error, result) => {
              if (error) {
                return reject(error);
              }
              if (!result) {
                return reject(new Error("Something went wrong!"));
              }
              resolve(result);
              // return result;
            },
          )
          .end(resume?.buffer);
      });
    }),
  );
  const randomDoctorPassword = Math.random().toString(36).slice(-8); // Generate a random password
  console.log(randomDoctorPassword);

  const hashedPassword = await bcrypt.hash(randomDoctorPassword, 10); // Hash the password
  const doctorApplication = await prisma.user.create({
    data: {
      ...payload.user,
      password: hashedPassword,
      role: Role.DOCTOR,
      needPasswordChange: true,
      doctor: {
        create: {
          ...payload.doctor,
          name: payload.user.name,
          email: payload.user.email,
          resume: resumeUploadResult.secure_url,
          resumePublicId: resumeUploadResult.public_id,
          additionalFiles: additionalFilesUploadResults.map((file) => ({
            url: file.secure_url,
            publicId: file.public_id,
          })),
        },
      },
    },
    include: {
      doctor: true,
    },
  });

  const expirationSeconds = 60 * 60;
  const otpKey = `doctor-application-otp:${payload.user.email}`;
  const otpValue = crypto.randomInt(100000, 1000000).toString();

  await redisClient.set(otpKey, otpValue, {
    expiration: {
      type: "EX",
      value: expirationSeconds,
    },
  });

  const templatePath = path.join(
    process.cwd(),
    "src/app/templates/registration-user-otp.ejs",
  );

  const templateData = {
    name: payload.user.name,
    email: payload.user.email,
    otp: otpValue,
    expirationMinutes: expirationSeconds / 60,
  };

  const html = await ejs.renderFile(templatePath, templateData);

  await transporter.sendMail({
    from: config.email_sender,
    to: payload.user.email,
    subject: "Welcome to NestCare - A medical Care Platform",
    html,
  });
  return doctorApplication;
};

const verifyDoctorEmail = async (payload: IVerifyDoctorEmailPayload) => {
  const otp = payload.otp;
  const email = payload.email;
  // console.log(email, otp);
  const existingUser = await prisma.user.findUnique({
    where: {
      email,
      role: Role.DOCTOR,
    },
  });

  if (!existingUser) {
    throw new Error("Doctor Application not found. please apply again");
  }

  if (existingUser.emailVerified) {
    throw new Error("Email Already verified");
  }

  const otpKey = `doctor-application-otp:${email}`;
  const redisOtp = await redisClient.get(otpKey);
  if (!redisOtp) {
    throw new Error("OTP expired. please apply again");
  }
  if (redisOtp !== otp) {
    throw new Error("Invalid OTP. please apply again");
  }

  await redisClient.del(otpKey);
  const verifiedUser = await prisma.user.update({
    where: { id: existingUser.id },
    data: { emailVerified: true },
    omit: { password: true },
    include: { doctor: true },
  });

  return verifiedUser;
};

const approveDoctor = async (
  payload: IApproveDoctorPayload,
  reviewer: RequestUser,
) => {
  const { doctorId, verificationStatus, rejectionReason } = payload;

  const existingDoctor = await prisma.doctor.findUnique({
    where: { id: doctorId },
    include: { user: true },
  });

  if (!existingDoctor) {
    throw new Error("Doctor Application not found");
  }

  if (existingDoctor.isDeleted) {
    throw new Error("Doctor application has been deleted");
  }

  if (!existingDoctor.user.emailVerified) {
    throw new Error(
      "Doctor has not verified their email yet. Application cannot be reviewed",
    );
  }

  if (existingDoctor.verificationStatus !== DoctorVerificationStatus.PENDING) {
    throw new Error(
      `Doctor application has already been ${existingDoctor.verificationStatus.toLowerCase()}`,
    );
  }

  if (
    verificationStatus === DoctorVerificationStatus.REJECTED &&
    !rejectionReason
  ) {
    throw new Error("Rejection reason is required");
  }

  const updatedDoctor = await prisma.doctor.update({
    where: { id: doctorId },
    data: {
      verificationStatus,
      rejectionReason:
        verificationStatus === DoctorVerificationStatus.REJECTED
          ? rejectionReason
          : null,
      reviewedBy: reviewer.userId,
      reviewedAt: new Date(),
    },
  });
};

export const DoctorService = {
  applyAsDoctor,
  verifyDoctorEmail,
  approveDoctor,
};
