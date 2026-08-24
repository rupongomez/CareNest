import { UploadApiResponse } from "cloudinary";
import { prisma } from "../../lib/prisma";
import { cloudinaryUpload } from "../../lib/cloudinary";
import bcrypt from "bcryptjs";
import { Role } from "../../../generated/prisma/enums";

const applyAsDoctor = async (
  payload: any,
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
  });
  return doctorApplication;
};

export const DoctorService = {
  applyAsDoctor,
};
