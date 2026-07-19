import { useEffect, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Mail } from "lucide-react";

const COMPANY_EMAIL_DOMAIN = "@yeehaiglobal.net";

/**
 * EmailGuard: Enforces company email domain for non-admin users.
 * If user is not admin and email doesn't match @yeehaiglobal.net,
 * shows a non-dismissible modal and logs out on confirmation.
 */
export function EmailGuard() {
  const { user, logout, isAuthenticated } = useAuth();
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    // Only check if user is authenticated and loaded
    if (!isAuthenticated || !user) {
      return;
    }

    // Admin users bypass email check
    if (user.role === "admin") {
      return;
    }

    // Check if email ends with company domain
    const email = user.email || "";
    const isCompanyEmail = email.endsWith(COMPANY_EMAIL_DOMAIN);

    if (!isCompanyEmail) {
      setShowModal(true);
    }
  }, [isAuthenticated, user]);

  const handleConfirm = async () => {
    setShowModal(false);
    await logout();
    // Redirect to login happens in useAuth hook
  };

  return (
    <AlertDialog open={showModal} onOpenChange={() => {
      // Prevent closing by clicking outside or pressing Escape
      // onOpenChange is only called when trying to close, so we ignore it
    }}>
      <AlertDialogContent className="max-w-md rounded-2xl">
        <AlertDialogHeader>
          <div className="flex items-center gap-2 mb-2">
            <Mail className="w-5 h-5 text-amber-500" />
            <AlertDialogTitle>邮箱验证</AlertDialogTitle>
          </div>
          <AlertDialogDescription className="text-base text-gray-700">
            目前您似乎没有使用公司邮箱 @yeehaiglobal.net 进行登录哦~
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="mt-4 flex justify-end">
          <AlertDialogAction onClick={handleConfirm}>
            确认
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
