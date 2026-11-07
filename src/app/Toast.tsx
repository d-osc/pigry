/** Toast notification state and component. */
import { useCallback, useState } from 'react';
import { CircleCheck, CircleX } from 'lucide-react';
import './Toast.css';

export interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error';
}

let nextId = 0;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, type: Toast['type'] = 'success') => {
    const id = ++nextId;
    setToasts((prev) => [...prev, { id, message, type }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  return { toasts, push };
}

export function ToastContainer({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toast-container" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.type}`}>
          {toast.type === 'success' ? (
            <CircleCheck size={14} />
          ) : (
            <CircleX size={14} />
          )}
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
