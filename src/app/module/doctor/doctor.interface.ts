import type { DoctorVerificationStatus } from "../../../generated/prisma/enums";

export interface IApplyAsDoctorPayload {
  user: {
    name: string;
    email: string;
  };
  doctor: {
    address?: string;
    specialization: string;
    experienceYears: number;
    bio?: string;
    licenseNumber: string;
    qualifications: string;
    consultationFee?: number;
    contactNumber?: string;
  };
}

export interface IVerifyDoctorEmailPayload {
  email: string;
  otp: string;
}

export interface IApproveDoctorPayload {
  doctorId: string;
  verificationStatus: DoctorVerificationStatus;
  rejectionReason?: string;
}

export interface IUpdateDoctorProfilePayload {
  address?: string;
  bio?: string;
  consultationFee?: number;
  contactNumber?: string;
}
