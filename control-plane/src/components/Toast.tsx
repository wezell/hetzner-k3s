'use client';

import type { ToastType } from '@/hooks/useToast';

interface ToastProps {
  message: string;
  type: ToastType;
  onClose: () => void;
}

export default function Toast({ message, type, onClose }: ToastProps) {
  const alertClass =
    type === 'success' ? 'alert-success'
    : type === 'error'   ? 'alert-error'
    : type === 'warning' ? 'alert-warning'
    : 'alert-info';

  return (
    <div className="toast toast-center toast-bottom z-[1000]">
      <div className={`alert ${alertClass} flex items-center gap-3 shadow-lg`}>
        <span className="flex-1 text-sm">{message}</span>
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          onClick={onClose}
          aria-label="Dismiss"
        >✕</button>
      </div>
    </div>
  );
}
