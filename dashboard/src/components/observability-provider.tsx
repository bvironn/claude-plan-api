"use client";

import * as React from "react";

class ReactErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 text-red-500">
          Something went wrong. Check the console for details.
        </div>
      );
    }
    return this.props.children;
  }
}

export function ObservabilityProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ReactErrorBoundary>{children}</ReactErrorBoundary>;
}
