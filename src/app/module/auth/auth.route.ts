import { Router } from "express";
import { Role } from "../../../generated/prisma/enums";
import { auth } from "../../middleware/checkAuth";
import { AuthController } from "./auth.controller";
import { validateRequest } from "../../middleware/validateRequest";
import { UserValidation } from "./auth.validation";

const router = Router();

router.post(
  "/register",
  validateRequest(UserValidation.PatientRegistrationZodSchema),
  AuthController.registerPatient,
);

router.post(
  "/verify-email",
  validateRequest(UserValidation.PatientEmailVerifyZodSchema),
  AuthController.verifyPatientEmail,
);
router.post(
  "/resend-verify-otp",
  // validateRequest(UserValidation.ResendVerificationOtpZodSchema),
  AuthController.resendVerificationOtp,
);
router.post(
  "/login",
  validateRequest(UserValidation.loginZodSchema),
  AuthController.loginUser,
);
router.post("/logout", AuthController.logout);
router.get(
  "/me",
  auth(Role.ADMIN, Role.DOCTOR, Role.PATIENT, Role.SUPER_ADMIN),
  AuthController.getMe,
);
router.post("/refresh-token", AuthController.refreshToken);
router.post("/google", AuthController.googleLogin);
router.post(
  "/forgot-password",
  validateRequest(UserValidation.ForgotPasswordZodSchema),
  AuthController.forgotPassword,
);
router.post(
  "/reset-password",
  validateRequest(UserValidation.ResetPasswordZodSchema),
  AuthController.resetPassword,
);
export const AuthRoutes = router;
