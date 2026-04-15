'use client';

import { useRef, useEffect, useState } from 'react';
import { useToast } from '@/hooks/useToast';
import Toast from '@/components/Toast';

interface ConfirmDeleteModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export default function ConfirmDeleteModal({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  onClose,
  onConfirm,
}: ConfirmDeleteModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [working, setWorking] = useState(false);
  const { toast, showToast, clearToast } = useToast();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) { dialog.showModal(); clearToast(); }
    else if (!open && dialog.open) dialog.close();
  }, [open, clearToast]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handler = () => { if (!working) onClose(); };
    dialog.addEventListener('close', handler);
    return () => dialog.removeEventListener('close', handler);
  }, [onClose, working]);

  async function handleConfirm() {
    setWorking(true);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'An error occurred. Please try again.', 'error');
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
    <dialog ref={dialogRef} className="modal">
      <div className="modal-box">
        <h3 className="font-bold text-lg">{title}</h3>
        <p className="py-4 text-base-content/80">{message}</p>

        <div className="modal-action">
          <button className="btn btn-ghost" onClick={onClose} disabled={working}>
            Cancel
          </button>
          <button className="btn btn-error" onClick={handleConfirm} disabled={working}>
            {working
              ? <><span className="loading loading-spinner loading-sm" />{confirmLabel}…</>
              : confirmLabel}
          </button>
        </div>
      </div>
      <div className="modal-backdrop" onClick={() => { if (!working) onClose(); }} />
    </dialog>
    {toast && <Toast message={toast.message} type={toast.type} onClose={clearToast} />}
    </>
  );
}
