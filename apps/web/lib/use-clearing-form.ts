"use client";

import { startTransition, useEffect, useRef, type FormEvent } from "react";

/**
 * Submits through onSubmit so a failed save keeps what the person typed (React's automatic reset
 * is skipped), and clears the form and focuses the confirmation once `done` changes.
 */
export function useClearingForm(done: string | undefined, formAction: (data: FormData) => void) {
  const formRef = useRef<HTMLFormElement>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (done) {
      formRef.current?.reset();
      doneRef.current?.focus();
    }
  }, [done]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return { formRef, doneRef, onSubmit };
}
