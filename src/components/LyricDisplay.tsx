import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';

interface LyricLine {
  time: number;
  text: string;
}

interface LyricDisplayProps {
  lyrics: LyricLine[];
  currentTime: number;
  totalDuration: number;
  palette: { primary: string; secondary: string; accent: string };
}

export const LyricDisplay: React.FC<LyricDisplayProps> = ({ lyrics, currentTime, totalDuration, palette }) => {
  const activeIndex = lyrics.findIndex((line, i) => 
    currentTime >= line.time && (i === lyrics.length - 1 || currentTime < lyrics[i + 1].time)
  );

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      const activeElement = containerRef.current.children[activeIndex] as HTMLElement;
      if (activeElement) {
        activeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [activeIndex]);

  return (
    <div ref={containerRef} className="h-64 overflow-y-auto no-scrollbar py-20 px-4 relative">
      {lyrics.map((line, index) => {
        const isActive = index === activeIndex;
        const nextTime = index < lyrics.length - 1 ? lyrics[index + 1].time : totalDuration;
        const duration = Math.max(0.1, nextTime - line.time);
        const progress = Math.min(100, Math.max(0, ((currentTime - line.time) / duration) * 100));
        
        return (
          <motion.div
            key={index}
            initial={{ opacity: 0, rotateX: -45, y: 30, scale: 0.9 }}
            animate={{ 
              opacity: isActive ? 1 : 0.3, 
              rotateX: isActive ? 0 : 15,
              y: 0,
              scale: isActive ? 1.1 : 1
            }}
            transition={{ 
              type: "spring",
              stiffness: 100,
              damping: 10,
              delay: isActive ? 0.1 : 0 
            }}
            className={`py-4 text-center relative ${
              isActive ? 'font-bold' : 'font-normal'
            }`}
            style={{ color: isActive ? palette.accent : '#94a3b8', transformStyle: 'preserve-3d' }}
          >
            {line.text}
            {isActive && (
                <div className="absolute bottom-1 left-1/4 w-1/2 h-0.5 bg-white/10 rounded-full overflow-hidden">
                    <motion.div
                        className="h-full rounded-full"
                        style={{ backgroundColor: palette.accent }}
                        initial={{ width: 0 }}
                        animate={{ width: `${progress}%` }}
                        transition={{ ease: "linear", duration: 0.1 }}
                    />
                </div>
            )}
          </motion.div>
        );
      })}
    </div>
  );
};
