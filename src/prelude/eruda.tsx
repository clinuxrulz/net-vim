
export default {
  metadata: {
    name: "eruda",
    description: "Mobile console for debugging"
  },
  setup: (api: any) => {
    // Check if we are in a browser environment
    if (typeof document === 'undefined') return;

    // Register a command to show/hide eruda manually if needed
    api.registerCommand("eruda", (args: string[]) => {
      // @ts-ignore
      if (typeof eruda !== 'undefined') {
        // @ts-ignore
        eruda.show();
      } else {
        api.log("Eruda is not loaded yet.");
      }
    });

    if (document.getElementById('eruda-cdn')) {
      api.log("Eruda script already present.");
      return;
    }

    api.log("Loading Eruda from CDN...");
    
    const script = document.createElement('script');
    script.id = 'eruda-cdn';
    script.src = "//cdn.jsdelivr.net/npm/eruda";
    script.onload = () => {
      // @ts-ignore
      if (typeof eruda !== 'undefined') {
        // @ts-ignore
        eruda.init();
        api.log("Eruda initialized successfully.");
      }
    };
    script.onerror = () => {
      api.log("Failed to load Eruda from CDN.");
    };
    document.head.appendChild(script);
  }
};
