import { UploadApiErrorResponse, UploadApiResponse } from "cloudinary";
import { AppointmentStatus, Role } from "../../../generated/prisma/enums";
import { prisma } from "../../lib/prisma";
import { RequestUser } from "../../middleware/checkAuth";
import { AppError } from "../../utils/AppError";
import { ICreatePrescriptionPayload } from "./prescription.interface";
import httpStatus from "http-status";
import PDFDocument from "pdfkit";
import { cloudinaryUpload } from "../../lib/cloudinary";
import path from "path";
import ejs from "ejs";
import { transporter } from "../../lib/nodemailer";
import config from "../../config";

const createPrescription = async (
  payload: ICreatePrescriptionPayload,
  user: RequestUser,
) => {
  const doctor = await prisma.doctor.findUnique({
    where: {
      userId: user.userId,
    },
  });

  if (!doctor) {
    throw new AppError(httpStatus.NOT_FOUND, "Doctor not found");
  }

  const appointment = await prisma.appointment.findUnique({
    where: {
      id: payload.appointmentId,
      doctorId: doctor.id,
    },
    include: {
      patient: true,
    },
  });

  if (!appointment) {
    throw new AppError(httpStatus.NOT_FOUND, "Appointment not found");
  }

  if (appointment.status !== AppointmentStatus.COMPLETED) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Prescription can only be written for a complete appointment",
    );
  }

  if (appointment.prescriptionUrl) {
    throw new AppError(
      httpStatus.CONFLICT,
      "A prescription already exists for this appointment",
    );
  }

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

  pdfDocument.fontSize(20).text("PH Healthcare System", { align: "center" });
  pdfDocument.fontSize(14).text("Prescription", { align: "center" });
  pdfDocument.moveDown(2);

  pdfDocument.fontSize(12).text(`Patient Name: ${appointment.patient.name}`);
  pdfDocument.text(`Doctor Name: ${doctor.name}`);
  pdfDocument.text(`Specialization: ${doctor.specialization}`);
  pdfDocument.text(`Date: ${new Date().toDateString()}`);
  pdfDocument.moveDown();

  pdfDocument.fontSize(14).text("Findings");
  pdfDocument.fontSize(12).text(payload.findings);
  pdfDocument.moveDown();

  pdfDocument.fontSize(14).text("Medicines");
  pdfDocument.moveDown(0.5);

  for (let i = 0; i < payload.medicines.length; i++) {
    const medicine = payload.medicines[i];

    pdfDocument.fontSize(12).text(`${i + 1}. ${medicine.name}`);
    pdfDocument.text(`   Dosage: ${medicine.dosage}`);
    pdfDocument.text(`   Duration: ${medicine.duration}`);

    if (medicine.instructions) {
      pdfDocument.text(`   Instructions: ${medicine.instructions}`);
    }

    pdfDocument.moveDown(0.5);
  }

  pdfDocument.end();

  const pdfBuffer = await pdfReadyPromise;

  const uploadResult = await new Promise<UploadApiResponse>(
    (resolve, reject) => {
      cloudinaryUpload.uploader
        .upload_stream(
          {
            resource_type: "raw",
            format: "pdf",
          },
          (error, result) => {
            if (error) {
              return reject(error);
            }
            if (!result) {
              return reject(
                new AppError(
                  httpStatus.INTERNAL_SERVER_ERROR,
                  "No result returned from Cloudinary",
                ),
              );
            }

            resolve(result);
          },
        )
        .end(pdfBuffer);
    },
  );

  const updatedAppointment = await prisma.appointment.update({
    where: { id: appointment.id },
    data: {
      prescriptionUrl: uploadResult.secure_url,
      prescriptionPublicId: uploadResult.public_id,
    },
  });

  const templatePath = path.join(
    process.cwd(),
    "src/app/templates/prescription.ejs",
  );
  const templateData = {
    name: name,
  };
  const html = await ejs.renderFile(templatePath, templateData);

  await transporter.sendMail({
    from: config.email_sender,
    to: appointment.patient.email,
    subject: "Your Prescription - CareNest Healthcare System",
    html,
    attachments: [
      {
        filename: "prescription.pdf",
        content: pdfBuffer,
      },
    ],
  });

  return updatedAppointment;
};

const getSinglePrescription = async (
  appointmentId: string,
  user: RequestUser,
) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      patient: { select: { id: true, name: true, userId: true } },
      doctor: { select: { id: true, name: true, userId: true } },
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

  if (!appointment.prescriptionUrl) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      "No prescription has been written yet",
    );
  }

  return {
    appointment,
    prescription: appointment.prescriptionUrl,
  };
};

export const PrescriptionServices = {
  createPrescription,
  getSinglePrescription,
};
