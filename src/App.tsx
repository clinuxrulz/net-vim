import { VimEditor } from '@net-vim/core';
import { onMount, createSignal, createEffect, on } from 'solid-js';

export default function App() {
  const [engine, setEngine] = createSignal<any>(null);
  const [viewportHeight, setViewportHeight] = createSignal(window.innerHeight);
  const [viewportTop, setViewportTop] = createSignal(0);

  createEffect(on(
    engine,
    (engine) => {
      if (engine == null) {
        return;
      }
      engine.getAPI().requestFocus();
    },
  ));

  onMount(() => {
    const updateViewport = () => {
      if (window.visualViewport) {
        setViewportHeight(window.visualViewport.height);
        setViewportTop(window.visualViewport.offsetTop);
      } else {
        setViewportHeight(window.innerHeight);
      }
    };

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateViewport);
      window.visualViewport.addEventListener('scroll', updateViewport);
      updateViewport();
      
      return () => {
        window.visualViewport?.removeEventListener('resize', updateViewport);
        window.visualViewport?.removeEventListener('scroll', updateViewport);
      };
    }
  });

  return (
    <div 
      style={{ 
        width: '100vw', 
        height: `${viewportHeight()}px`, 
        position: 'fixed',
        top: `${viewportTop()}px`,
        left: 0,
        overflow: 'hidden' 
      }}
    >
      <VimEditor ref={setEngine} autoCreateInit={true}/>
    </div>
  );
}
