import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "./api";
import { useAuth } from "./auth";

const RAZORPAY_CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

export type CreditPack = {
  id: string;
  label: string;
  credits?: number;
  price_paise?: number;
};

export type CreateOrderResponse = {
  order_id: string;
  amount_paise: number;
  key_id: string;
  pack: CreditPack;
  currency?: string;
};

export type RazorpaySuccessResponse = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

type RazorpayFailureResponse = {
  error?: {
    description?: string;
    reason?: string;
    code?: string;
  };
};

type RazorpayOptions = {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  handler: (response: RazorpaySuccessResponse) => void;
  modal?: { ondismiss?: () => void };
};

type RazorpayInstance = {
  open: () => void;
  on: (event: "payment.failed", handler: (response: RazorpayFailureResponse) => void) => void;
};

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

let checkoutScriptPromise: Promise<void> | null = null;

export function loadRazorpayCheckoutScript(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Razorpay checkout requires a browser environment"));
  }
  if (window.Razorpay) {
    return Promise.resolve();
  }
  if (checkoutScriptPromise) {
    return checkoutScriptPromise;
  }

  checkoutScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_CHECKOUT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Failed to load Razorpay checkout script")));
      return;
    }

    const script = document.createElement("script");
    script.src = RAZORPAY_CHECKOUT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      checkoutScriptPromise = null;
      reject(new Error("Failed to load Razorpay checkout script"));
    };
    document.body.appendChild(script);
  });

  return checkoutScriptPromise;
}

export function useCreateCreditOrder() {
  const { accessToken } = useAuth();

  return useMutation({
    mutationFn: (packId: string) =>
      apiFetch<CreateOrderResponse>("/payments/create-order", accessToken as string, {
        method: "POST",
        body: JSON.stringify({ pack_id: packId })
      })
  });
}

const CREDITS_REFRESH_DELAYS_MS = [0, 3000, 8000];

// Credits are granted by the payment webhook, not this client, so we can only
// nudge the "me" query a few times and wait for the server to catch up.
export function useRefreshCreditsAfterPayment() {
  const queryClient = useQueryClient();

  return () => {
    CREDITS_REFRESH_DELAYS_MS.forEach((delay) => {
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["me"] });
      }, delay);
    });
  };
}

export function openRazorpayCheckout(params: {
  order: CreateOrderResponse;
  onSuccess: (response: RazorpaySuccessResponse) => void;
  onDismiss: () => void;
  onFailure: (description: string) => void;
}): void {
  const { order, onSuccess, onDismiss, onFailure } = params;

  if (!window.Razorpay) {
    throw new Error("Razorpay checkout script has not loaded yet");
  }

  const instance = new window.Razorpay({
    key: order.key_id,
    order_id: order.order_id,
    amount: order.amount_paise,
    currency: order.currency ?? "INR",
    name: "MyTryonAi",
    description: order.pack.label,
    handler: onSuccess,
    modal: { ondismiss: onDismiss }
  });

  instance.on("payment.failed", (response) => {
    onFailure(response.error?.description || response.error?.reason || "Payment failed. Please try again.");
  });

  instance.open();
}
