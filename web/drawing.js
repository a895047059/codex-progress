(() => {
  const $=id=>document.getElementById(id),canvas=$('drawing-canvas'),ctx=canvas.getContext('2d');
  let callback=null,strokes=[],stroke=null;
  function paint(){
    ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);
    for(const s of strokes){
      ctx.strokeStyle=s.color;ctx.lineWidth=s.width;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();
      s.points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));
      if(s.points.length===1){ctx.lineTo(s.points[0].x+.01,s.points[0].y+.01);}ctx.stroke();
    }
    $('drawing-undo').disabled=!strokes.length;$('drawing-attach').disabled=!strokes.length;
  }
  function point(event){const r=canvas.getBoundingClientRect();return {x:(event.clientX-r.left)*canvas.width/r.width,y:(event.clientY-r.top)*canvas.height/r.height};}
  canvas.onpointerdown=event=>{canvas.setPointerCapture(event.pointerId);stroke={color:$('drawing-color').value,width:Number($('drawing-width').value)*2,points:[point(event)]};strokes.push(stroke);paint();};
  canvas.onpointermove=event=>{if(!stroke)return;stroke.points.push(point(event));paint();};
  canvas.onpointerup=canvas.onpointercancel=()=>{stroke=null;};
  $('drawing-undo').onclick=()=>{strokes.pop();paint();};$('drawing-clear').onclick=()=>{strokes=[];paint();};
  $('drawing-close').onclick=()=>$('drawing-dialog').close();
  $('drawing-attach').onclick=()=>{if(!strokes.length)return;callback?.({kind:'image',name:'草图.png',url:canvas.toDataURL('image/png')});$('drawing-dialog').close();};
  window.Drawing={open(onAttach){callback=onAttach;paint();$('drawing-dialog').showModal();}};
})();
