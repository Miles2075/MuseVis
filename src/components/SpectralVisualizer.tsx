import React, { useEffect, useRef } from 'react';
import { synthEngine } from '../utils/audioEngine';

interface SpectralVisualizerProps {
  palette: { primary: string; secondary: string; accent: string };
  className?: string;
}

export const SpectralVisualizer: React.FC<SpectralVisualizerProps> = ({ palette, className }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let animationFrame: number;

    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const data = synthEngine.getFrequencyData();
      const width = canvas.width;
      const height = canvas.height;

      ctx.clearRect(0, 0, width, height);

      const barWidth = width / data.length;
      let x = 0;

      for (let i = 0; i < data.length; i++) {
        const barHeight = (data[i] / 255) * height;
        
        // Create gradient based on palette
        const gradient = ctx.createLinearGradient(0, height, 0, height - barHeight);
        gradient.addColorStop(0, palette.secondary);
        gradient.addColorStop(1, palette.accent);
        
        ctx.fillStyle = gradient;
        ctx.fillRect(x, height - barHeight, barWidth - 1, barHeight);
        
        x += barWidth;
      }

      animationFrame = requestAnimationFrame(draw);
    };

    draw();

    return () => cancelAnimationFrame(animationFrame);
  }, [palette]);

  return <canvas ref={canvasRef} className={className} width={300} height={100} />;
};
